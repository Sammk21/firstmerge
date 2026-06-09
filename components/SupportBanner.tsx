import { bmcUrl, config } from "@/lib/config";

// Buy Me a Coffee support banner. FirstMerge is free and open source — no ads,
// no paywall. Donations cover the ~$6/mo VPS + domain so it can stay online and
// keep getting maintained.
export default function SupportBanner() {
  return (
    <section
      className="mt-12 overflow-hidden rounded-2xl p-6 sm:p-8"
      style={{ border: "1px solid var(--line)", background: "var(--bg-soft)" }}
    >
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-md">
          <div
            className="text-[19px] font-semibold tracking-[-0.01em]"
            style={{ color: "var(--ink)" }}
          >
            Keep FirstMerge free &amp; online
          </div>
          <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            This is a free, open-source project with no ads and no paywall. A coffee
            helps cover the server and domain it runs on (~$6/mo) and the time spent
            keeping the data fresh and the issues flowing. Every bit keeps it alive.
          </p>
        </div>

        <a
          href={bmcUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-full px-5 py-2.5 text-[15px] font-medium transition-colors hover:bg-[color:var(--accent-press)]"
          style={{ background: "var(--accent)", color: "#ffffff" }}
        >
          Buy me a coffee
        </a>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px]" style={{ color: "var(--ink-faint)" }}>
        <a href={config.repoUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
          ★ Star on GitHub
        </a>
        <span>·</span>
        <a href={config.repoUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
          Contribute / self-host
        </a>
        <span>·</span>
        <span>MIT licensed</span>
      </div>
    </section>
  );
}
