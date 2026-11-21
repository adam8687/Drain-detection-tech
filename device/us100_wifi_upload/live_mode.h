#pragma once
#include <stdint.h>
// Monotonic, bounded lease; signed subtraction also handles millis() wrapping.
class LiveMode {
 public:
  static constexpr int maxBatchSize = 10;
  void apply(uint32_t remainingMs, uint32_t requestStartedAt) {
    enabled_ = remainingMs > 0;
    until_ = requestStartedAt + (remainingMs > 120000 ? 120000 : remainingMs);
  }
  bool active(uint32_t now) const { return enabled_ && int32_t(until_ - now) > 0; }
  int batchSize(uint32_t now) const { return active(now) ? 1 : maxBatchSize; }
  uint32_t uploadGapMs(uint32_t now) const { return active(now) ? 750 : 100; }
 private:
  bool enabled_ = false;
  uint32_t until_ = 0;
};
