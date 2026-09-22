/*
 * Tiny helper that turns the whole display grayscale.
 *
 * It drives the same switch as System Settings > Accessibility > Display >
 * Color Filters (category 1 = "__Color__", filter type 1 = Grayscale) through
 * MediaAccessibility.framework.
 *
 * It deliberately does NOT use the private CGDisplayForceToGray: that call
 * still sets and reports its own flag on macOS 26, but the display keeps
 * rendering in color, so the app silently did nothing. Verified on 26.5.2.
 *
 * Because this is a real system setting, a user who already relies on Color
 * Filters must not have it taken away — the app checks `status` at launch and
 * leaves the filter alone if it was already on.
 *
 * Compiled by scripts/build-helper.sh:
 *   clang -O2 -framework CoreFoundation -framework MediaAccessibility \
 *     -o grayscale grayscale.c
 *
 * Usage: grayscale on|off|status|type
 */
#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

extern void MADisplayFilterPrefSetCategoryEnabled(int category, bool enabled);
extern bool MADisplayFilterPrefGetCategoryEnabled(int category);
extern void MADisplayFilterPrefSetType(int category, int type);
extern int  MADisplayFilterPrefGetType(int category);

#define COLOR_CATEGORY 1
#define GRAYSCALE_TYPE 1

int main(int argc, char **argv) {
    const char *cmd = (argc < 2) ? "status" : argv[1];

    if (strcmp(cmd, "status") == 0) {
        printf(MADisplayFilterPrefGetCategoryEnabled(COLOR_CATEGORY) ? "on\n" : "off\n");
        return 0;
    }
    if (strcmp(cmd, "type") == 0) {
        printf("%d\n", MADisplayFilterPrefGetType(COLOR_CATEGORY));
        return 0;
    }
    if (strcmp(cmd, "on") == 0) {
        /* Force grayscale rather than whichever color filter was configured. */
        if (MADisplayFilterPrefGetType(COLOR_CATEGORY) != GRAYSCALE_TYPE) {
            MADisplayFilterPrefSetType(COLOR_CATEGORY, GRAYSCALE_TYPE);
        }
        MADisplayFilterPrefSetCategoryEnabled(COLOR_CATEGORY, true);
        return MADisplayFilterPrefGetCategoryEnabled(COLOR_CATEGORY) ? 0 : 1;
    }
    if (strcmp(cmd, "off") == 0) {
        MADisplayFilterPrefSetCategoryEnabled(COLOR_CATEGORY, false);
        return MADisplayFilterPrefGetCategoryEnabled(COLOR_CATEGORY) ? 1 : 0;
    }
    fprintf(stderr, "usage: grayscale on|off|status|type\n");
    return 2;
}
