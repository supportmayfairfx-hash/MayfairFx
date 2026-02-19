function hash32(s: string): number {
  // FNV-1a 32-bit
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildQuotes(): string[] {
  // Handcrafted core + deterministic combinatorics to reach 1000+ short trading-focused quotes.
  const core = [
    "Trade your plan, not your mood.",
    "Protect capital first. Profit follows.",
    "Small losses are the cost of staying in the game.",
    "Patience is a position.",
    "Let winners breathe. Cut losers fast.",
    "Consistency beats intensity.",
    "Boring trading is good trading.",
    "If it's not in the plan, it's noise.",
    "One good trade is enough for today.",
    "You don't need to catch every move.",
    "Risk small, think big.",
    "Process over profit.",
    "Discipline is a trading edge.",
    "Avoid revenge trades.",
    "Wait for your setup.",
    "Size down when uncertain.",
    "No trade is a valid trade.",
    "Respect the stop.",
    "The market rewards patience.",
    "Focus on execution, not outcome.",
    "Your job is risk management.",
    "Trade less. Improve more.",
    "Don't chase. Replace.",
    "Trade what you see, not what you feel.",
    "A plan removes stress.",
    "Keep it simple.",
    "Be selective. Be consistent.",
    "Missed trades are better than bad trades.",
    "Good entries start with good waiting.",
    "Don't fight the tape.",
    "Know your invalidation.",
    "Reduce risk after a loss.",
    "Protect your mental capital.",
    "Stop trading when tired.",
    "Do the boring work daily.",
    "Trade the best, ignore the rest.",
    "If you can't define risk, don't enter.",
    "Your edge is repetition.",
    "Journal everything that matters.",
    "Calm mind, clear execution.",
    "Follow rules, not impulses.",
    "Less leverage, more longevity.",
    "Cut the noise. Keep the signal.",
    "Cash is a position.",
    "Take trades you can explain.",
    "Don't average down losers.",
    "Adapt, don't predict.",
    "Be early to plan, late to panic.",
    "Drawdown control is profit control.",
    "Win the day by avoiding mistakes."
  ];

  const verbs = [
    "Protect",
    "Preserve",
    "Respect",
    "Control",
    "Limit",
    "Manage",
    "Plan",
    "Define",
    "Measure",
    "Review",
    "Journal",
    "Execute",
    "Wait",
    "Hold",
    "Exit",
    "Reduce",
    "Increase",
    "Simplify",
    "Focus",
    "Ignore",
    "Follow",
    "Trust",
    "Improve",
    "Train",
    "Refine"
  ];

  const objects = [
    "risk",
    "position size",
    "your stop",
    "your rules",
    "your edge",
    "your process",
    "capital",
    "patience",
    "discipline",
    "execution",
    "the plan",
    "the setup",
    "the trend",
    "your mindset",
    "your journal",
    "your entries",
    "your exits",
    "your time",
    "your focus",
    "your emotions",
    "your leverage",
    "drawdown",
    "consistency",
    "clarity",
    "quality"
  ];

  const outcomes = [
    "and profits take care of themselves.",
    "and stay in the game.",
    "before you press buy or sell.",
    "every single session.",
    "until it becomes automatic.",
    "to trade with confidence.",
    "to avoid costly mistakes.",
    "so you can trade tomorrow.",
    "to keep your edge sharp.",
    "and keep stress low.",
    "and let time work for you."
  ];

  const pairs = [
    ["Patience", "pays"],
    ["Discipline", "wins"],
    ["Consistency", "compounds"],
    ["Risk control", "builds confidence"],
    ["A clear plan", "reduces fear"],
    ["Small size", "keeps you calm"],
    ["A good stop", "keeps you alive"],
    ["Less trading", "improves accuracy"],
    ["A calm mind", "sees opportunity"],
    ["Selective trades", "raise results"],
    ["Clean charts", "clear decisions"],
    ["Simple rules", "scale well"],
    ["Good habits", "beat good guesses"],
    ["Capital", "is your ammunition"],
    ["Time", "is your ally"]
  ];

  const micro = [
    "Wait for confirmation.",
    "Trade the best setup only.",
    "If in doubt, stay out.",
    "One trade at a time.",
    "No stop, no trade.",
    "Size down and survive.",
    "Follow the rules today.",
    "Protect the account.",
    "Don't chase candles.",
    "Respect key levels.",
    "Keep losses small.",
    "Let winners run.",
    "Take profits with a plan.",
    "Avoid overtrading.",
    "Breathe before entry.",
    "Zoom out for clarity.",
    "Trade what you can manage.",
    "Reduce noise, increase focus.",
    "Consistency over excitement.",
    "Setup first, trade second."
  ];

  const set = new Set<string>();
  for (const q of core) set.add(q);
  for (const q of micro) set.add(q);

  // Deterministic combinatorics. Keep quotes short.
  for (let i = 0; i < verbs.length; i++) {
    for (let j = 0; j < objects.length; j++) {
      const base = `${verbs[i]} ${objects[j]}.`;
      set.add(base);
      set.add(`${base} ${outcomes[(i + j) % outcomes.length]}`);
      if (set.size >= 1400) break;
    }
    if (set.size >= 1400) break;
  }

  for (const [a, b] of pairs) {
    set.add(`${a} ${b}.`);
    set.add(`${a} ${b} over time.`);
  }

  // Fill to at least 1100 with slightly varied but still meaningful lines.
  const starters = ["Remember:", "Rule:", "Note:", "Today:", "Always:"];
  const endings = ["Stay sharp.", "Stay disciplined.", "Stay patient.", "Stay small.", "Stay consistent."];
  const obj2 = ["risk", "entries", "exits", "stops", "targets", "size", "leverage", "rules", "focus", "journal"];
  for (let i = 0; set.size < 1200; i++) {
    const s = starters[i % starters.length];
    const e = endings[i % endings.length];
    const o = obj2[i % obj2.length];
    set.add(`${s} manage ${o}. ${e}`);
  }

  return Array.from(set);
}

export const TRADING_QUOTES: string[] = buildQuotes().slice(0, 1000);

export function pickTradingQuote(key: string): string {
  const k = String(key || "");
  const list = TRADING_QUOTES;
  if (!list.length) return "Trade your plan.";
  const idx = hash32(k) % list.length;
  return list[idx];
}

