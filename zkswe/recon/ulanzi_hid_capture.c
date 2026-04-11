// Ulanzi D200H HID capture interposer for macOS.
// Interposes IOHIDDeviceSetReport and dumps raw D200H HID reports to disk.
//
// Build:
//   bash zkswe/recon/build-ulanzi-hid-capture.sh
//
// Run a target app with:
//   AGENTDECK_D200H_CAPTURE_DIR=~/.agentdeck/ulanzi-capture/raw \
//   DYLD_INSERT_LIBRARIES=.../ulanzi-hid-capture.dylib \
//   /Applications/UlanziStudio.app/Contents/MacOS/UlanziStudio

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDLib.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#define D200H_VID 0x2207
#define D200H_PID 0x0019

typedef IOReturn (*iohid_set_report_fn)(
    IOHIDDeviceRef device,
    IOHIDReportType reportType,
    CFIndex reportID,
    const uint8_t *report,
    CFIndex reportLength
);

static iohid_set_report_fn real_IOHIDDeviceSetReport = NULL;
static pthread_mutex_t capture_lock = PTHREAD_MUTEX_INITIALIZER;
static uint64_t capture_seq = 0;
static bool capture_ready = false;
static char capture_dir[PATH_MAX];

#define DYLD_INTERPOSE(_replacement, _replacee) \
    __attribute__((used)) static struct { \
        const void *replacement; \
        const void *replacee; \
    } _interpose_##_replacee __attribute__((section("__DATA,__interpose"))) = { \
        (const void *)(unsigned long)&_replacement, \
        (const void *)(unsigned long)&_replacee \
    };

static long long now_millis(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return ((long long) tv.tv_sec * 1000LL) + (tv.tv_usec / 1000);
}

static int int_property(IOHIDDeviceRef device, const char *key_name) {
    CFStringRef key = CFStringCreateWithCString(kCFAllocatorDefault, key_name, kCFStringEncodingUTF8);
    if (!key) return -1;
    CFTypeRef value = IOHIDDeviceGetProperty(device, key);
    CFRelease(key);
    if (!value || CFGetTypeID(value) != CFNumberGetTypeID()) {
        return -1;
    }
    int result = -1;
    CFNumberGetValue((CFNumberRef) value, kCFNumberIntType, &result);
    return result;
}

static bool is_d200h_device(IOHIDDeviceRef device) {
    int vid = int_property(device, kIOHIDVendorIDKey);
    int pid = int_property(device, kIOHIDProductIDKey);
    return vid == D200H_VID && pid == D200H_PID;
}

static void ensure_capture_dir(void) {
    if (capture_ready) return;

    const char *dir = getenv("AGENTDECK_D200H_CAPTURE_DIR");
    if (!dir || !dir[0]) {
        const char *home = getenv("HOME");
        if (!home || !home[0]) home = "/tmp";
        snprintf(capture_dir, sizeof(capture_dir), "%s/.agentdeck/ulanzi-hid-capture", home);
    } else {
        snprintf(capture_dir, sizeof(capture_dir), "%s", dir);
    }

    mkdir(capture_dir, 0755);
    capture_ready = true;
}

static void append_event_line(const char *line) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/events.log", capture_dir);
    int fd = open(path, O_CREAT | O_WRONLY | O_APPEND, 0644);
    if (fd < 0) return;
    write(fd, line, strlen(line));
    write(fd, "\n", 1);
    close(fd);
}

static void dump_report_bytes(
    IOHIDDeviceRef device,
    IOHIDReportType reportType,
    CFIndex reportID,
    const uint8_t *report,
    CFIndex reportLength,
    IOReturn result
) {
    ensure_capture_dir();

    int cmd = -1;
    uint32_t total = 0;
    bool framed = reportLength >= 8 && report[0] == 0x7C && report[1] == 0x7C;
    if (framed) {
        cmd = ((int) report[2] << 8) | report[3];
        total = (uint32_t) report[4] |
            ((uint32_t) report[5] << 8) |
            ((uint32_t) report[6] << 16) |
            ((uint32_t) report[7] << 24);
    }

    const uint64_t seq = ++capture_seq;
    const long long ts = now_millis();
    char basename[PATH_MAX];
    snprintf(
        basename,
        sizeof(basename),
        "%s/%06llu-%lld-cmd%04X-len%04ld-rid%02ld-result%d",
        capture_dir,
        (unsigned long long) seq,
        ts,
        cmd >= 0 ? cmd : 0,
        (long) reportLength,
        (long) reportID,
        (int) result
    );

    char bin_path[PATH_MAX];
    snprintf(bin_path, sizeof(bin_path), "%s.bin", basename);
    int fd = open(bin_path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
    if (fd >= 0) {
        write(fd, report, (size_t) reportLength);
        close(fd);
    }

    char log_line[1024];
    snprintf(
        log_line,
        sizeof(log_line),
        "seq=%06llu ts=%lld vid=%04X pid=%04X type=%d reportID=%ld len=%ld cmd=%s total=%u result=%d",
        (unsigned long long) seq,
        ts,
        int_property(device, kIOHIDVendorIDKey),
        int_property(device, kIOHIDProductIDKey),
        (int) reportType,
        (long) reportID,
        (long) reportLength,
        framed ? "framed" : "raw",
        total,
        (int) result
    );
    append_event_line(log_line);
}

static void ensure_real_symbol(void) {
    if (real_IOHIDDeviceSetReport) return;
    real_IOHIDDeviceSetReport = (iohid_set_report_fn) dlsym(RTLD_NEXT, "IOHIDDeviceSetReport");
}

IOReturn capture_IOHIDDeviceSetReport(
    IOHIDDeviceRef device,
    IOHIDReportType reportType,
    CFIndex reportID,
    const uint8_t *report,
    CFIndex reportLength
) {
    ensure_real_symbol();
    if (!real_IOHIDDeviceSetReport) {
        return kIOReturnError;
    }

    const bool should_capture = device && report && reportLength > 0 && is_d200h_device(device);
    IOReturn result = real_IOHIDDeviceSetReport(device, reportType, reportID, report, reportLength);

    if (!should_capture) {
        return result;
    }

    pthread_mutex_lock(&capture_lock);
    dump_report_bytes(device, reportType, reportID, report, reportLength, result);
    pthread_mutex_unlock(&capture_lock);
    return result;
}

DYLD_INTERPOSE(capture_IOHIDDeviceSetReport, IOHIDDeviceSetReport);
