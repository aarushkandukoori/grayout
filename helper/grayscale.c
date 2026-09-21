/*
 * Tiny helper that toggles macOS system-wide grayscale rendering using the
 * private CoreGraphics "force to gray" API. Compiled on first launch by the app:
 *   clang -O2 -framework ApplicationServices -o grayscale grayscale.c
 *
 * Usage: grayscale on|off|status
 */
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

extern void CGDisplayForceToGray(bool forceToGray);
extern bool CGDisplayUsesForceToGray(void);

int main(int argc, char **argv) {
    if (argc < 2 || strcmp(argv[1], "status") == 0) {
        printf(CGDisplayUsesForceToGray() ? "on\n" : "off\n");
        return 0;
    }
    if (strcmp(argv[1], "on") == 0) {
        CGDisplayForceToGray(true);
        return 0;
    }
    if (strcmp(argv[1], "off") == 0) {
        CGDisplayForceToGray(false);
        return 0;
    }
    fprintf(stderr, "usage: grayscale on|off|status\n");
    return 1;
}
