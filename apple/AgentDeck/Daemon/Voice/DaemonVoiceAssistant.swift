#if os(macOS)
// DaemonVoiceAssistant.swift — Voice assistant pipeline
// Ported from bridge/src/voice-assistant.ts + bridge/src/voice.ts
// AVAudioEngine recording, whisper transcription, AVSpeechSynthesizer TTS

import Foundation
import AVFoundation
import Speech

/// Voice assistant: record → transcribe → send to agent → TTS response
@MainActor
final class DaemonVoiceAssistant {
    enum State: String, Sendable {
        case idle, listening, processing, speaking, disabled
    }

    private(set) var state: State = .idle
    private var audioEngine: AVAudioEngine?
    private var audioFile: AVAudioFile?
    private var recordingURL: URL?
    private let synthesizer = AVSpeechSynthesizer()

    // Callbacks
    var onStateChanged: ((State, String?, String?) -> Void)?  // (state, text, responseText)
    var onTranscription: ((String) -> Void)?
    var sendPrompt: ((String) -> Void)?

    // Config
    private let maxRecordingDuration: TimeInterval = 15
    private let silenceTimeout: TimeInterval = 1.5
    private let silenceThreshold: Float = 0.01
    private var recordingTimer: Task<Void, Never>?
    private var silenceTimer: Task<Void, Never>?
    private var lastSoundTime: Date = .now

    // Whisper
    private let whisperServerPort = 9100

    // MARK: - Lifecycle

    func start() -> Bool {
        // Check microphone permission
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            return false
        default:
            state = .disabled
            onStateChanged?(.disabled, nil, nil)
            return false
        }

        state = .idle
        DaemonLogger.shared.info("Voice assistant ready")
        return true
    }

    func stop() {
        stopRecording()
        state = .idle
    }

    // MARK: - Recording

    func startRecording() {
        guard state == .idle else { return }
        state = .listening
        onStateChanged?(.listening, nil, nil)

        let engine = AVAudioEngine()
        self.audioEngine = engine

        let tempDir = FileManager.default.temporaryDirectory
        let url = tempDir.appendingPathComponent("agentdeck-voice-\(UUID().uuidString).wav")
        self.recordingURL = url

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        do {
            audioFile = try AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
            ])
        } catch {
            DaemonLogger.shared.error("Failed to create audio file: \(error)")
            state = .idle
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            Task { @MainActor in
                self?.processAudioBuffer(buffer)
            }
        }

        do {
            try engine.start()
            lastSoundTime = .now
            DaemonLogger.shared.debug("Voice", "Recording started")
        } catch {
            DaemonLogger.shared.error("Failed to start audio engine: \(error)")
            state = .idle
            return
        }

        // Max recording timer
        recordingTimer = Task {
            try? await Task.sleep(for: .seconds(maxRecordingDuration))
            guard !Task.isCancelled else { return }
            self.stopRecording()
            self.transcribe()
        }
    }

    func stopRecording() {
        recordingTimer?.cancel()
        silenceTimer?.cancel()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        audioFile = nil
    }

    func cancelRecording() {
        stopRecording()
        if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        recordingURL = nil
        state = .idle
        onStateChanged?(.idle, nil, nil)
    }

    // MARK: - Audio Processing

    private func processAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        // Write to file
        try? audioFile?.write(from: buffer)

        // RMS silence detection
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frameCount = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<frameCount { sum += channelData[i] * channelData[i] }
        let rms = sqrt(sum / Float(frameCount))

        if rms > silenceThreshold {
            lastSoundTime = .now
            silenceTimer?.cancel()
        } else if Date().timeIntervalSince(lastSoundTime) > silenceTimeout && state == .listening {
            // Silence detected — stop and transcribe
            silenceTimer?.cancel()
            silenceTimer = Task {
                self.stopRecording()
                self.transcribe()
            }
        }
    }

    // MARK: - Transcription

    private func transcribe() {
        guard let url = recordingURL else { return }
        state = .processing
        onStateChanged?(.processing, nil, nil)

        Task {
            // Check file size (skip if silence only)
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let size = attrs?[.size] as? Int ?? 0
            if size < 1000 {
                DaemonLogger.shared.debug("Voice", "Recording too small (\(size)B), likely silence")
                self.cancelRecording()
                return
            }

            // Try whisper-server first, then whisper CLI
            let text: String?
            if let result = await transcribeViaServer(url) {
                text = result
            } else {
                text = await transcribeViaCLI(url)
            }

            // Cleanup recording
            try? FileManager.default.removeItem(at: url)
            recordingURL = nil

            guard let text, !text.isEmpty else {
                state = .idle
                onStateChanged?(.idle, nil, nil)
                return
            }

            DaemonLogger.shared.debug("Voice", "Transcribed: \(text)")
            onStateChanged?(.processing, text, nil)
            onTranscription?(text)

            // Send to agent
            sendPrompt?(text)
        }
    }

    private func transcribeViaServer(_ url: URL) async -> String? {
        // Check if whisper-server is running
        let serverURL = URL(string: "http://127.0.0.1:\(whisperServerPort)/inference")!
        var request = URLRequest(url: serverURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 30

        // Build multipart form data
        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        let fileData = try? Data(contentsOf: url)
        guard let fileData else { return nil }

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let text = json["text"] as? String {
                return text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func transcribeViaCLI(_ url: URL) async -> String? {
        // Find whisper-cli
        let candidates = ["/usr/local/bin/whisper-cli", "/opt/homebrew/bin/whisper-cli"]
        guard let whisperPath = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            DaemonLogger.shared.debug("Voice", "whisper-cli not found")
            return nil
        }

        // Find model
        let modelDirs = [
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/whisper.cpp").path,
            "/usr/local/share/whisper.cpp/models",
        ]
        var modelPath: String?
        for dir in modelDirs {
            let path = "\(dir)/ggml-base.bin"
            if FileManager.default.fileExists(atPath: path) { modelPath = path; break }
        }
        guard let modelPath else {
            DaemonLogger.shared.debug("Voice", "No whisper model found")
            return nil
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: whisperPath)
        process.arguments = ["-m", modelPath, "-f", url.path, "--no-timestamps", "-l", "auto"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            return output.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    // MARK: - TTS

    func speak(_ text: String) {
        state = .speaking
        onStateChanged?(.speaking, nil, text)

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "ko-KR") ?? AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate

        synthesizer.speak(utterance)

        // Monitor completion
        Task {
            while synthesizer.isSpeaking {
                try? await Task.sleep(for: .milliseconds(200))
            }
            state = .idle
            onStateChanged?(.idle, nil, nil)
        }
    }

    /// Handle agent response — TTS if voice assistant initiated the prompt
    func handleResponse(_ text: String) {
        guard state == .processing else { return }
        speak(text.isEmpty ? "완료했습니다." : String(text.prefix(200)))
    }
}
#endif
