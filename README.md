# cold-email-agent

A **generalist, multi-niche cold-email outreach agent** powered by **SmartLead**.

It sends cold-email sequences to leads across many target categories ("niches") — financial
advisors first, with relocation experts, legal professionals, doctors/dentists, and more to
follow. One agent, many niches; each niche's leads live in their own Postgres table
(`niche_leads.<name>`). Discovery and
copy happen elsewhere — this project reads a niche's leads and runs the outreach via SmartLead.

**Start here:** [SPEC.md](SPEC.md) — the foundational spec (broad by design; details are worked
out during the build).
