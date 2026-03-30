#define _DEFAULT_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define FB_SIZE (540 * 960 * 4) // 2,073,600 bytes
#define RAM_START 0x30000000LL
#define RAM_END   0x40000000LL
#define ALIAS_OFFSET 0x20000000LL

int main(int argc, char **argv) {
    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) { perror("open /dev/mem"); return 1; }

    printf("=== NUCLEAR MEMORY SWEEP (SSD210/202) ===\n");
    printf("Wiping %lld to %lld with WHITE...\n", RAM_START, RAM_END);

    uint32_t *white = malloc(FB_SIZE);
    memset(white, 0xFF, FB_SIZE);

    for (uint64_t addr = RAM_START; addr < RAM_END; addr += (1024 * 1024)) {
        printf("Trying addr: 0x%llx (and cached alias)\n", (unsigned long long)addr);
        
        uint64_t targets[2] = { addr, addr + ALIAS_OFFSET };
        for (int i = 0; i < 2; i++) {
            void *ptr = mmap(NULL, FB_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, targets[i]);
            if (ptr != MAP_FAILED) {
                memcpy(ptr, white, FB_SIZE);
                munmap(ptr, FB_SIZE);
            }
        }
        // Small sleep so the user can spot the flash
        usleep(50000); 
    }

    printf("Sweep complete. If you saw white, we have the address!\n");
    free(white);
    close(fd);
    return 0;
}
