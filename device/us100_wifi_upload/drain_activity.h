#pragma once
// Detects, from raw distance readings alone, when water has appeared and when the sink is quiet again, so the board can
// upload the moment a drain ends instead of waiting for a batch to fill. It needs no calibration: the idle distance is
// the median of recent quiet readings. It only decides WHEN to upload; the server still judges the drain from the
// readings themselves. Plain C++ with no Arduino dependencies so it can be unit-tested on a computer.
class DrainActivity {
 public:
  static constexpr int WINDOW = 9;         // recent quiet readings that define the idle distance
  static constexpr int START_MM = 12;      // this far from idle counts as disturbed (water shortens the reading by its depth)
  static constexpr int QUIET_MM = 6;       // back within this of idle counts as quiet
  static constexpr int START_CONFIRM = 2;  // disturbed readings in a row before it counts as activity (rejects stray echoes)
  static constexpr int END_CONFIRM = 3;    // quiet readings in a row before the drain counts as finished

  // Feed every reading (a failed reading is -1). Returns true exactly once, when an active period has just ended.
  bool update(int mm) {
    if (mm < 0) return false;                         // a failed reading neither starts nor ends anything
    if (count_ < WINDOW) { push(mm); return false; }  // learn the idle distance first
    const int base = baseline(), off = mm > base ? mm - base : base - mm;
    if (!active_) {
      if (off >= START_MM) { if (++disturbed_ >= START_CONFIRM) { active_ = true; quiet_ = 0; } }
      else { disturbed_ = 0; push(mm); }               // only quiet readings move the idle distance
      return false;
    }
    if (off <= QUIET_MM) {
      if (++quiet_ >= END_CONFIRM) { active_ = false; disturbed_ = 0; quiet_ = 0; return true; }
    } else quiet_ = 0;
    return false;
  }
  bool active() const { return active_; }
  int baseline() const {                              // median of the recent quiet readings
    int v[WINDOW];
    for (int i = 0; i < count_; i++) v[i] = ring_[i];
    for (int i = 1; i < count_; i++) { const int x = v[i]; int j = i - 1; while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; } v[j + 1] = x; }
    return count_ ? v[count_ / 2] : 0;
  }

 private:
  int ring_[WINDOW] = {0}, count_ = 0, next_ = 0, disturbed_ = 0, quiet_ = 0;
  bool active_ = false;
  void push(int v) { ring_[next_] = v; next_ = (next_ + 1) % WINDOW; if (count_ < WINDOW) count_++; }
};
