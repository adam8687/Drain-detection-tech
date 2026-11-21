#include <assert.h>
#include <stdio.h>
#include "../us100_wifi_upload/live_mode.h"
int main() {
 LiveMode mode;
 assert(!mode.active(0));assert(mode.batchSize(0)==10);assert(mode.uploadGapMs(0)==100);
 mode.apply(120000,1000);assert(mode.active(1001));assert(mode.batchSize(1001)==1);assert(mode.uploadGapMs(1001)==750);
 assert(mode.active(120999));assert(!mode.active(121000));assert(mode.batchSize(121000)==10);assert(mode.uploadGapMs(121000)==100);
 mode.apply(999999,1000);assert(!mode.active(121000)); // server cannot extend past the cap
 mode.apply(30000,1000);mode.apply(0,2000);assert(!mode.active(2000));
 mode.apply(1000,0xfffffff0u);assert(mode.active(0xfffffff1u));assert(mode.active(500));assert(!mode.active(984));
 mode.apply(120000,0);assert(!mode.active(120001)); // a slow/lost response does not restart its lifetime
 puts("live mode: all checks passed");
}
