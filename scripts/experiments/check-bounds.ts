/** Quick sanity table for the three bounds; not an experiment, a guard rail. */
import { bettingUpperBound, ebUpperBound, worUpperBound } from "@lore/core/sivm";
function main() {
  const d = 0.05 / 6;
  const cases: Array<[string, number[]]> = [
    ["n=45 clean", new Array(45).fill(0)],
    ["n=90 clean", new Array(90).fill(0)],
    ["n=360 clean", new Array(360).fill(0)],
    ["n=720 @6%", Array.from({ length: 720 }, (_, i) => (i % 17 === 0 ? 1 : 0))],
  ];
  for (const [name, x] of cases) {
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    const eb = ebUpperBound(x, d);
    const bt = bettingUpperBound(x, 0.05);
    const wr = worUpperBound(x, d, 1800);
    console.log(
      `${name.padEnd(12)} mean=${mean.toFixed(4)} EB=${eb.toFixed(4)} betting=${bt.toFixed(4)} WoR=${wr.toFixed(4)} | all>=mean=${eb >= mean && bt >= mean && wr >= mean}`,
    );
  }
}
main();
