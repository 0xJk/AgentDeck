/**
 * Type declarations for optional Picovoice dependencies.
 * These packages are in optionalDependencies and may not be installed.
 */

declare module '@picovoice/porcupine-node' {
  export class Porcupine {
    readonly frameLength: number;
    readonly sampleRate: number;
    constructor(
      accessKey: string,
      keywordPaths: string[],
      sensitivities: number[],
      options?: { modelPath?: string; device?: string; libraryPath?: string },
    );
    process(pcm: Int16Array): number;
    release(): void;
  }
}

declare module '@picovoice/pvrecorder-node' {
  export class PvRecorder {
    constructor(frameLength: number, deviceIndex?: number);
    start(): void;
    stop(): void;
    read(): Promise<Int16Array>;
    release(): void;
    getSelectedDevice(): string;
    static getAvailableDevices(): string[];
  }
}
