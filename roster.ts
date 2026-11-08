// The roster's pure rules, shared by the server and the settings page: which seats there are, the
// checks on a roster, and the presets. No SDK calls and no claim about which model is better.
import { ROLE_IDS, ROLES } from "./roles";

/** Agents whose provider, model and reasoning level the person picks: every role plus the trial comparison. */
export const AGENT_KEYS = [...ROLE_IDS, "comparison"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];
export const AGENT_LABELS: Record<AgentKey, string> = {
  ...Object.fromEntries(ROLE_IDS.map((role) => [role, ROLES[role].label])),
  comparison: "Reviewer trial comparison",
} as Record<AgentKey, string>;

/** Reasoning levels bb understands, lowest first; each model lists the ones it offers. */
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;

/** A seat's provider, model and reasoning level; null means the provider's or model's default. */
export type Exec = { providerId: string; model: string | null; reasoningLevel: string | null };

/** How a seat reads in a list: provider · model · reasoning. */
export function showExec(exec: Exec): string {
  return `${exec.providerId} · ${exec.model ?? "default model"} · ${exec.reasoningLevel ?? "default reasoning"}`;
}

export type RosterWarning = { id: string; title: string; detail: string };
/**
 * Checks that make no claim about which model is better: can each seat run, and does anything
 * independent check the Builder's work? `providers` is null when the provider list couldn't be
 * read, so a failed lookup never reads as "unavailable".
 */
export function rosterWarnings(
  roles: Record<string, { providerId: string }>,
  providers: readonly { id: string; available: boolean }[] | null,
  options: { shadowOn: boolean },
): RosterWarning[] {
  const warnings: RosterWarning[] = [];
  const builder = roles.build?.providerId;
  if (builder !== undefined && roles.review1?.providerId === builder && roles.security?.providerId === builder) {
    const secondProvider = roles.review2 !== undefined && roles.review2.providerId !== builder;
    warnings.push({
      id: "roster-shared-provider",
      title: `The Builder, Reviewer 1 and Security all run on ${builder}`,
      detail: secondProvider
        ? `Only large or sensitive PRs get a second provider, through Reviewer 2 (${roles.review2!.providerId}). Reviewers on the same provider tend to share blind spots, so move Reviewer 1 to another provider if you have one.`
        : "No review comes from a second provider, and reviewers on the same provider tend to share blind spots. Move Reviewer 1 to another provider if you have one.",
    });
  }
  if (providers !== null) {
    const seats = AGENT_KEYS.filter((key) => options.shadowOn || (key !== "shadow" && key !== "comparison"));
    const unavailable = new Map<string, string[]>();
    for (const role of seats) {
      const providerId = roles[role]?.providerId;
      if (providerId === undefined || providers.some((provider) => provider.id === providerId && provider.available)) continue;
      unavailable.set(providerId, [...(unavailable.get(providerId) ?? []), AGENT_LABELS[role]]);
    }
    for (const [providerId, labels] of unavailable) {
      warnings.push({
        id: `roster-unavailable-${providerId}`,
        title: `${providerId} isn't available for ${labels.join(", ")}`,
        detail: `Agents in these seats won't start until it's signed in or the seat moves to another provider.`,
      });
    }
  }
  return warnings;
}

// ----- Roster presets -----

export const ROSTER_PRESETS = ["balanced", "lower-cost", "max-depth"] as const;
export type RosterPreset = (typeof ROSTER_PRESETS)[number];
export const ROSTER_PRESET_LABELS: Record<RosterPreset, string> = { balanced: "Balanced", "lower-cost": "Lower cost", "max-depth": "Maximum depth" };
export const ROSTER_PRESET_NOTES: Record<RosterPreset, string> = {
  balanced: "Keeps each seat as you set it, with reviews moved to other providers",
  "lower-cost": "Balanced, with less reasoning on seats that read more than they write",
  "max-depth": "Balanced, with more reasoning where judgment matters and a third provider for Reviewer 2",
};
/** The trial seats keep what the person set up for the trial. */
export const PRESET_SEATS = ["lead", "plan", "explore", "build", "qa", "design", "review1", "review2", "security", "designreview"] as const;
/** Reviewer seats stay the person's choice: proposed, but applied only when ticked. */
const PRESET_REVIEWER_SEATS: readonly string[] = ["review1", "review2", "security"];
/** Seats that read more than they write, where Lower cost lowers reasoning. */
const PRESET_READING_SEATS: readonly string[] = ["lead", "qa", "explore", "designreview"];
/** Seats where Maximum depth raises reasoning. */
const PRESET_DEPTH_SEATS: readonly string[] = ["plan", "designreview", "review1", "review2", "security"];
/** Levels a preset may pick. none, ultra and ultracode are special modes: kept when set, never picked. */
const PICKABLE_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const levelRank = (level: string) => (REASONING_LEVELS as readonly string[]).indexOf(level);

/** `model` is the catalog's other id for the same model, which a saved seat may use. */
export type CatalogModel = { id: string; model: string; isDefault: boolean; defaultReasoningEffort: string; efforts: string[] };
/** `models` has no entry for a provider whose models couldn't be read. */
export type RosterCatalog = { providers: readonly { id: string; available: boolean }[]; models: Readonly<Record<string, readonly CatalogModel[]>> };
export type PresetSeat = { key: string; current: Exec; proposed: Exec; why: string[]; changed: boolean; ticked: boolean; reviewer: boolean };

/**
 * A preset's proposal for each seat, from the providers and models on this machine. Rules only: no
 * claim about which model is better. Balanced keeps each seat as the person set it, but moves
 * Reviewer 1 off the Builder's provider, design reviewers off the Planner's, and any seat off a
 * provider that isn't available. Lower cost lowers reasoning on seats that read more than they
 * write; Maximum depth raises it where judgment matters, and puts Reviewer 2 on a third provider
 * when there is one. A preset never lowers a level under Maximum depth or raises one under Lower
 * cost, and leaves a level alone when it can't read the model's levels.
 */
export function computePreset(preset: RosterPreset, roles: Readonly<Record<string, Exec>>, catalog: RosterCatalog): PresetSeat[] {
  const available = catalog.providers.filter((provider) => provider.available).map((provider) => provider.id);
  // Providers already in the roster come first, so a preset doesn't bring in one nobody uses.
  const familiar = [...new Set(PRESET_SEATS.map((key) => roles[key]?.providerId).filter((id): id is string => id !== undefined && available.includes(id)))];
  const order = [...familiar, ...available.filter((id) => !familiar.includes(id))];
  const pick = (current: string, avoid: readonly string[]): string | null => {
    if (available.includes(current) && !avoid.includes(current)) return current;
    return order.find((id) => !avoid.includes(id)) ?? null;
  };
  const findModel = (providerId: string, model: string | null) => {
    const models = catalog.models[providerId];
    if (models === undefined) return undefined;
    return model === null ? models.find((entry) => entry.isDefault) : models.find((entry) => entry.id === model || entry.model === model);
  };
  const proposedProvider: Record<string, string> = {};
  // Another seat's provider as proposed. Only ticked seats are applied, but this is enough: a seat
  // a preset moves was on an unavailable provider (which is never picked) or, for Reviewer 1, on the
  // Builder's (which Reviewer 2 avoids too). So its saved provider never needs avoiding.
  const of = (key: string) => [proposedProvider[key] ?? roles[key]?.providerId].filter((id): id is string => id !== undefined);
  const seats: PresetSeat[] = [];
  for (const key of PRESET_SEATS) {
    const current = roles[key];
    if (current === undefined) continue;
    const why: string[] = [];
    let avoid: string[] = [];
    if (key === "review1") avoid = of("build");
    if (key === "designreview") avoid = of("plan");
    if (key === "review2" && preset === "max-depth") avoid = [...of("build"), ...of("review1")];
    let providerId = pick(current.providerId, avoid);
    // "third": Reviewer 2 found no third provider but is off the Builder's. "alone": no other provider at all.
    let fallback: "third" | "alone" | null = null;
    if (providerId === null && key === "review2") {
      providerId = pick(current.providerId, of("build"));
      if (providerId !== null) fallback = "third";
    }
    if (providerId === null && avoid.length > 0) {
      // Keep the seat running rather than independent.
      fallback = "alone";
      providerId = pick(current.providerId, []);
    }
    providerId ??= current.providerId;
    proposedProvider[key] = providerId;
    const moved = providerId !== current.providerId;
    if (moved && !available.includes(current.providerId)) why.push(`Moved to ${providerId}: ${current.providerId} isn't available here`);
    else if (fallback === "third") why.push(moved ? `Moved to ${providerId}: no third provider is available, so it at least runs on one other than the Builder's` : "No third provider is available, so it stays off the Builder's");
    else if (fallback === "alone") why.push("No other provider is available here, so it can't be independent");
    else if (moved) {
      why.push(key === "review1" ? `Moved to ${providerId}: Reviewer 1 checks the Builder's work, so it runs on another provider`
        : key === "designreview" ? `Moved to ${providerId}: design reviewers read the plan fresh, so they run on a provider other than the Planner's`
        : key === "review2" ? `Moved to ${providerId}: at maximum depth, Reviewer 2 adds a third provider`
        : `Moved to ${providerId}`);
    }
    const model = moved ? null : current.model;
    if (model !== null) why.push(`Keeps the model you picked (${model})`);
    const entry = findModel(providerId, model);
    const offered = (entry?.efforts ?? []).filter((effort) => PICKABLE_LEVELS.includes(effort)).sort((a, b) => levelRank(a) - levelRank(b));
    const set = moved ? null : current.reasoningLevel;
    const target = preset === "lower-cost" && PRESET_READING_SEATS.includes(key) ? offered[0] ?? null
      : preset === "max-depth" && PRESET_DEPTH_SEATS.includes(key) ? offered.at(-1) ?? null
      : null;
    const targeted = (preset === "lower-cost" && PRESET_READING_SEATS.includes(key)) || (preset === "max-depth" && PRESET_DEPTH_SEATS.includes(key));
    let reasoningLevel: string | null = set;
    if (targeted && entry === undefined && !moved) {
      why.push(catalog.models[providerId] === undefined
        ? `Couldn't read ${providerId}'s models, so its reasoning level stays as it is`
        : `Its model isn't in ${providerId}'s list, so its reasoning level stays as it is`);
    } else if (targeted && target !== null) {
      // Never the wrong way: Lower cost doesn't raise a level, Maximum depth doesn't lower one.
      const unknown = set !== null && levelRank(set) === -1;
      const wrongWay = set !== null && !unknown && (preset === "lower-cost" ? levelRank(set) < levelRank(target) : levelRank(set) > levelRank(target));
      if (unknown) why.push(`Keeps the reasoning level you set (${set}): the preset can't place it among the levels it knows`);
      else if (wrongWay) why.push(`Keeps the reasoning level you set (${set}): the preset would ${preset === "lower-cost" ? "raise" : "lower"} it`);
      else {
        reasoningLevel = target;
        why.push(preset === "lower-cost" ? `Lowest reasoning level its model offers (${target}): this seat reads more than it writes` : `Highest reasoning level its model offers (${target})`);
      }
    } else if (set !== null) {
      why.push(`Keeps the reasoning level you set (${set})`);
    }
    if (reasoningLevel === null) why.push(`The model's default reasoning level${entry === undefined ? "" : ` (${entry.defaultReasoningEffort})`}`);
    const reviewer = PRESET_REVIEWER_SEATS.includes(key);
    if (reviewer) why.push("A reviewer seat: applied only if you tick it");
    const proposed: Exec = { providerId, model, reasoningLevel };
    const changed = !sameExec(proposed, current);
    seats.push({ key, current, proposed, why, changed, ticked: changed && !reviewer, reviewer });
  }
  return seats;
}

export function sameExec(a: Exec, b: Exec): boolean {
  return a.providerId === b.providerId && a.model === b.model && a.reasoningLevel === b.reasoningLevel;
}
