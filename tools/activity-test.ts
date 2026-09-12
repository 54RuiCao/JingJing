/**
 * P3.7 契约测试：**阅读活动**（每天读了多少秒/翻了多少页）与 **主页槽位**。
 *
 * 为什么要单独一套：这两件事都是"宿主统计、插件呈现"的边界 ——
 * 算错的是日子（时区）、连续天数、最长连续这些**看起来简单但很容易算错**的东西，
 * 而插件只能照着宿主的数字画图，所以口径必须在这里钉死。纯函数，node 里直接跑。
 *
 * 跑法：node tools/run-tests.mjs activity-test
 */

import {
  dayKey,
  daysBetween,
  shiftDay,
  summarizeActivity,
  type ActivityRow,
} from "../app/src/reader/readingActivity";
import { SHIPPED_SLOTS } from "../app/src/ui/builtin/uiLayout";
import { ASYNC_OPS, OP_CAPABILITY } from "../app/src/core/plugin/runtime-quickjs";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

// ---------- 1) 日期口径 ----------

check("dayKey 用本地时区（不能用 toISOString）", dayKey(new Date(2026, 8, 12, 23, 30)) === "2026-09-12");
check("dayKey 补零", dayKey(new Date(2026, 0, 5)) === "2026-01-05");
check("跨月回退一天", shiftDay("2026-03-01", -1) === "2026-02-28");
check("跨年前进一天", shiftDay("2025-12-31", 1) === "2026-01-01");
check("闰年 2 月", shiftDay("2024-02-28", 1) === "2024-02-29");
check("daysBetween 相邻 = 1", daysBetween("2026-09-11", "2026-09-12") === 1);
check("daysBetween 跨月 = 3", daysBetween("2026-08-30", "2026-09-02") === 3);

// ---------- 2) 汇总：连续天数 / 最长连续 / 最好的一天 ----------

const rows: ActivityRow[] = [
  { day: "2026-09-01", seconds: 600, turns: 20 },
  { day: "2026-09-02", seconds: 0, turns: 5 },      // 只翻了几页也算活跃
  { day: "2026-09-03", seconds: 1800, turns: 60 },
  { day: "2026-09-05", seconds: 60, turns: 2 },      // 9-04 断了
  { day: "2026-09-11", seconds: 300, turns: 10 },
  { day: "2026-09-12", seconds: 900, turns: 30 },
];
const s = summarizeActivity(rows, "2026-09-12");
check("今天读了多少", s.todaySeconds === 900 && s.todayTurns === 30);
check("活跃天数（只翻页没到结算也算）", s.activeDays === 6, String(s.activeDays));
check("总时长", s.totalSeconds === 3660, String(s.totalSeconds));
check("连续天数截至今天 = 2", s.streak === 2, String(s.streak));
check("最长连续 = 3", s.longestStreak === 3, String(s.longestStreak));
check("最好的一天", s.bestDay?.day === "2026-09-03" && s.bestDay?.seconds === 1800);
check("days 升序", s.days.map((d) => d.day).join() === "2026-09-01,2026-09-02,2026-09-03,2026-09-05,2026-09-11,2026-09-12");

// 今天还没读：连续天数从昨天起算（不该归零）
const noToday = summarizeActivity(rows.slice(0, 5), "2026-09-12");
check("今天还没读时连续天数从昨天算", noToday.streak === 1, String(noToday.streak));
check("今天没读 → todaySeconds = 0", noToday.todaySeconds === 0);

// 昨天也没读 → 连续为 0
const broken = summarizeActivity([{ day: "2026-09-01", seconds: 60, turns: 1 }], "2026-09-12");
check("断了很多天 → 连续 0", broken.streak === 0);
check("但总时长与活跃天数还在", broken.totalSeconds === 60 && broken.activeDays === 1);

// 同一日期两行（宿主分两次结算）要合并，不能互相覆盖
const merged = summarizeActivity(
  [
    { day: "2026-09-12", seconds: 100, turns: 1 },
    { day: "2026-09-12", seconds: 200, turns: 2 },
  ],
  "2026-09-12",
);
check("同一天多行合并", merged.todaySeconds === 300 && merged.todayTurns === 3, JSON.stringify(merged.days));

// 脏数据不该把统计带崩
const dirty = summarizeActivity(
  [
    { day: "2026-09-12", seconds: -5, turns: Number.NaN as unknown as number },
    { day: "", seconds: 100, turns: 1 },
  ],
  "2026-09-12",
);
check("负时长/NaN/空日期被清掉", dirty.todaySeconds === 0 && dirty.days.length === 1 && dirty.days[0].day === "2026-09-12");
check("空输入不炸", summarizeActivity([], "2026-09-12").activeDays === 0);

// ---------- 3) 主页槽位与插件 API 的接线事实 ----------

const slot = SHIPPED_SLOTS.find((s) => s.name === "library.view.top");
check("library.view.top 已声明", !!slot);
check("library.view.top 已接线（wired:true）—— 没接线的话挂上去也不会显示", slot?.declaration.wired === true);
check("它是加法席位（replaceRisk:none，不遮挡书架）", slot?.declaration.replaceRisk === "none" && slot?.declaration.kind === "list");

check("阅读活动走 reader.read 能力", OP_CAPABILITY["reader.activity"] === "reader.read");
check("它是异步 op（宿主 IO）", ASYNC_OPS.has("reader.activity"));

console.log("P3.7 阅读活动契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（日期口径 / 连续与最长连续 / 脏数据 / 主页槽位与 activity op 接线）");
