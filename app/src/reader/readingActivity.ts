/**
 * 阅读活动的口径与汇总（P3.7）。
 *
 * **为什么这件事在宿主而不在插件里**：插件沙箱没有定时器（连 setTimeout 都没有）、
 * 也不知道"阅读页是否可见 / 窗口有没有焦点 / 刚才那一下算不算在读书" —— 那些只有宿主知道。
 * 所以宿主负责**采集事实**（每天多少秒、翻了多少页），插件负责**呈现**（热力图、目标、排行）。
 *
 * 这个模块是纯函数：日期口径与连续天数/最长连续这些"最容易算错"的地方都在这里，
 * 并且能被 node 里的契约测试直接驱动。
 */

export type ActivityRow = {
  /** 本地时区 YYYY-MM-DD */
  day: string;
  seconds: number;
  turns: number;
};

export type ActivitySnapshot = {
  /** 今天的日期键（宿主时区） */
  today: string;
  todaySeconds: number;
  todayTurns: number;
  /** 有记录的日子（升序；没有记录的日子不在数组里，由呈现方自己补空格） */
  days: ActivityRow[];
  totalSeconds: number;
  activeDays: number;
  /** 截至今天的连续天数：今天还没读不算断（从昨天往回数） */
  streak: number;
  longestStreak: number;
  bestDay: ActivityRow | null;
};

const pad = (n: number) => (n < 10 ? "0" + n : String(n));

/** 本地时区的 YYYY-MM-DD（**不能用 toISOString**：那是 UTC，晚上读的书会算到前一天） */
export function dayKey(ts: number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** 日期键偏移若干天（用本地时间构造，避免夏令时把日期算错） */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map((x) => Number(x));
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + delta);
  return dayKey(dt);
}

/** 两个日期键之间差几天（b - a） */
export function daysBetween(a: string, b: string): number {
  const toUTC = (s: string) => {
    const [y, m, d] = s.split("-").map((x) => Number(x));
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

/** 把数据库里的行汇总成插件要的那份快照 */
export function summarizeActivity(rows: ActivityRow[], today: string): ActivitySnapshot {
  const byDay = new Map<string, ActivityRow>();
  for (const r of rows ?? []) {
    if (!r?.day) continue;
    const prev = byDay.get(r.day);
    byDay.set(r.day, {
      day: r.day,
      seconds: Math.max(0, Math.round(Number(r.seconds) || 0)) + (prev?.seconds ?? 0),
      turns: Math.max(0, Math.round(Number(r.turns) || 0)) + (prev?.turns ?? 0),
    });
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const totalSeconds = days.reduce((n, d) => n + d.seconds, 0);
  // "活跃的一天" = 真的读了（只翻页没到结算时间也算）
  const active = days.filter((d) => d.seconds > 0 || d.turns > 0);
  const activeDays = active.length;

  // 连续天数：今天没读就从昨天起算（进度条不该因为"今天还没读"就归零）
  let cursor = byDay.has(today) && (byDay.get(today)!.seconds > 0 || byDay.get(today)!.turns > 0) ? today : shiftDay(today, -1);
  let streak = 0;
  while (true) {
    const row = byDay.get(cursor);
    if (!row || (row.seconds <= 0 && row.turns <= 0)) break;
    streak++;
    cursor = shiftDay(cursor, -1);
  }

  let longestStreak = 0;
  let run = 0;
  let prevDay: string | null = null;
  for (const d of active) {
    run = prevDay && daysBetween(prevDay, d.day) === 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prevDay = d.day;
  }

  const bestDay = active.reduce<ActivityRow | null>((best, d) => (!best || d.seconds > best.seconds ? d : best), null);
  return {
    today,
    todaySeconds: byDay.get(today)?.seconds ?? 0,
    todayTurns: byDay.get(today)?.turns ?? 0,
    days,
    totalSeconds,
    activeDays,
    streak,
    longestStreak,
    bestDay,
  };
}
