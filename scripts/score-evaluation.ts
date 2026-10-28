import { readFile, writeFile } from "node:fs/promises";
async function main() {
  const directory = process.argv[2];
  if (!directory)
    throw new Error(
      "Usage: tsx scripts/score-evaluation.ts .data/evaluations/<run>",
    );
  const review = JSON.parse(
    await readFile(directory + "/blind-review.json", "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(directory + "/manifest.json", "utf8"),
  );
  const metrics = [
    "importantEventRecall",
    "unsupportedClaims",
    "evidenceAccuracy",
    "technicalErrors",
    "editTimeMinutes",
  ];
  const summary: Record<string, any> = {};
  let pending = 0;
  for (const item of review) {
    const original = manifest.find((m: any) => m.id === item.id);
    if (!original) throw new Error("Unknown review ID");
    if (
      metrics.some(
        (k) => item.scores?.[k] === null || item.scores?.[k] === undefined,
      )
    ) {
      pending++;
      continue;
    }
    for (const metric of metrics) {
      const v = item.scores[metric];
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < 0 ||
        ([
          "importantEventRecall",
          "unsupportedClaims",
          "evidenceAccuracy",
        ].includes(metric) &&
          v > 1)
      )
        throw new Error("Invalid score: " + metric);
    }
    const group = (summary[original.condition] ??= {
      count: 0,
      totals: Object.fromEntries(metrics.map((k) => [k, 0])),
    });
    group.count++;
    for (const k of metrics) group.totals[k] += item.scores[k];
  }
  const report = {
    pending,
    scored: review.length - pending,
    conditions: Object.fromEntries(
      Object.entries(summary).map(([condition, g]) => [
        condition,
        {
          count: g.count,
          means: Object.fromEntries(
            metrics.map((k) => [k, g.totals[k] / g.count]),
          ),
        },
      ]),
    ),
    interpretation:
      "Small-sample descriptive comparison. Review event recall and unsupported-claim rate together. No population-wide inference.",
  };
  await writeFile(
    directory + "/scores-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
