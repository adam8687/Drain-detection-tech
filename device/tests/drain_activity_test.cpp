// Host-side test for the firmware's drain-end detector. Build: c++ -std=c++17 drain_activity_test.cpp -o test && ./test
#include <cstdio>
#include <cstdlib>
#include <vector>
#include "../us100_wifi_upload/drain_activity.h"
static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { std::printf("FAIL: %s\n", msg); failures++; } } while (0)
static unsigned seed = 7;
static int noise(int amp) { seed = seed * 1103515245u + 12345u; return int((seed >> 16) % (2 * amp + 1)) - amp; }
// Feed readings; returns the index at which each drain end fired.
static std::vector<int> run(DrainActivity& d, const std::vector<int>& readings) {
  std::vector<int> ends; for (size_t i = 0; i < readings.size(); i++) if (d.update(readings[i])) ends.push_back(int(i)); return ends; }
static std::vector<int> idle(int n, int mm = 300, int amp = 1) { std::vector<int> v; for (int i = 0; i < n; i++) v.push_back(mm + noise(amp)); return v; }
static void add(std::vector<int>& a, const std::vector<int>& b) { a.insert(a.end(), b.begin(), b.end()); }
// A use: fill to 45 mm, hold, fall to dry (the sensor reads 300 - depth).
static std::vector<int> use(int holdReadings, int fallReadings) {
  std::vector<int> v; for (int i = 0; i < 6; i++) v.push_back(300 - 45 * i / 5 + noise(1)); for (int i = 0; i < holdReadings; i++) v.push_back(255 + noise(1));
  for (int i = 0; i < fallReadings; i++) v.push_back(255 + 45 * (i + 1) / fallReadings + noise(1)); return v; }

int main() {
  { DrainActivity d; std::vector<int> r = idle(20); add(r, use(6, 16)); const int endAt = int(r.size()); add(r, idle(12));
    auto ends = run(d, r);
    CHECK(ends.size() == 1, "one drain, one end");
    CHECK(!ends.empty() && ends[0] >= endAt - 4 && ends[0] <= endAt + 2, "fires within a few readings of the sink going dry");
    CHECK(!d.active(), "quiet again afterwards"); }
  { DrainActivity d; auto ends = run(d, idle(200, 300, 2)); CHECK(ends.empty(), "ordinary noise never counts as a drain"); }
  { DrainActivity d; std::vector<int> r = idle(20); r[12] = 80; r[15] = 40; add(r, idle(30)); auto ends = run(d, r);
    CHECK(ends.empty() && !d.active(), "isolated stray echoes do not start activity"); }
  { DrainActivity d; std::vector<int> r = idle(20); auto u = use(6, 16); u[8] = 300; add(r, u); add(r, idle(12)); auto ends = run(d, r);
    CHECK(ends.size() == 1, "one quiet-looking echo in the middle of a drain does not end it early");
    CHECK(!ends.empty() && ends[0] > 20 + 20, "and it fires after the real end"); }
  { DrainActivity d; std::vector<int> r = idle(20); auto u = use(6, 16); for (int i = 10; i < 14; i++) u[i] = -1; add(r, u); add(r, idle(12)); auto ends = run(d, r);
    CHECK(ends.size() == 1, "failed readings during a drain neither end nor split it"); }
  { DrainActivity d; std::vector<int> r = idle(20); add(r, use(40, 16)); add(r, idle(12)); add(r, use(6, 16)); add(r, idle(12)); auto ends = run(d, r);
    CHECK(ends.size() == 2, "two uses give two ends, including a long hold"); }
  { DrainActivity d; std::vector<int> r = idle(20); for (int i = 0; i < 60; i++) r.push_back(260 + noise(1)); auto ends = run(d, r);
    CHECK(ends.empty() && d.active(), "standing water never reports a finished drain"); }
  { DrainActivity d; std::vector<int> r; for (int i = 0; i < 300; i++) r.push_back(300 + i / 20 + noise(1)); auto ends = run(d, r);
    CHECK(ends.empty() && !d.active(), "slow drift of the idle distance is followed, not mistaken for use"); }
  { DrainActivity d; std::vector<int> r = idle(4); auto ends = run(d, r); CHECK(ends.empty() && d.baseline() > 0, "learning phase is safe"); }
  if (failures) { std::printf("%d failure(s)\n", failures); return 1; }
  std::printf("drain activity: all checks passed\n"); return 0; }
