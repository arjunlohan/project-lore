import type { Metadata } from "next";
import { LoreSearch } from "./lore-search";

export const metadata: Metadata = {
  title: "lore · people search",
  description:
    "Natural-language search over 89,184 developer profiles, compiled to deterministic filters on Elasticsearch or MySQL.",
};

export default function LorePage() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-4 px-4 py-8">
      <LoreSearch />
    </main>
  );
}
