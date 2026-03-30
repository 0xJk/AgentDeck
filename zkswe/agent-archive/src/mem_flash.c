#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <stdint.h>
#include <string.h>

void flash(int fd, uint32_t addr, uint32_t size, uint32_t color) {
    printf("Flashing 0x%08x (size %d MB) with color 0x%08x\n", addr, size/(1024*1024), color);
    uint8_t *mem = (uint8_t *)mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, addr);
    if (mem == MAP_FAILED) {
        perror("mmap failed");
        return;
    }
    uint32_t *pixels = (uint32_t *)mem;
    for (uint32_t i = 0; i < size/4; i++) {
        pixels[i] = color;
    }
    munmap(mem, size);
}

int main(int argc, char **argv) {
    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) {
        perror("open /dev/mem");
        return 1;
    }

    /* Range 1: 0x50000000 (standard bus alias candidate) - MAGENTA */
    flash(fd, 0x50000000, 8*1024*1024, 0xffff00ff);

    /* Range 2: 0x30000000 (fb0 smem_start base range) - CYAN */
    flash(fd, 0x30000000, 16*1024*1024, 0xff00ffff);

    /* Range 3: 0x10000000 (lower range) - YELLOW */
    flash(fd, 0x10000000, 8*1024*1024, 0xffffff00);

    /* Range 4: 0x40100000 (another common variant) - WHITE */
    flash(fd, 0x40000000, 8*1024*1024, 0xffffffff);

    close(fd);
    printf("Flash completed. Check screen!\n");
    return 0;
}
