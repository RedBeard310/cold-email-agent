// Niche-agnostic engine types. Anything vertical-specific lives in a niche config
// (src/niches/<niche>/), never here. See SPEC.md §3.

/** One email step within a sequence. */
export interface EmailStep {
  /** Days to wait before sending this step, relative to the previous step. First step = 0. */
  delayDays: number;
  /** Subject line. Only the first step sets one; follow-ups thread under it ("Re: ..."). */
  subject?: string;
  /** Body. May contain {spintax|like this} and {{merge_tags}} (double-brace = SmartLead variable). */
  body: string;
}

/** A full sequence = one SmartLead campaign. */
export interface SequenceDef {
  /** Suffix used to build the campaign name: `${campaignPrefix}${name}`. */
  name: string;
  emails: EmailStep[];
}

/** Maps one SmartLead lead field to an Airtable source field + optional transform. */
export interface FieldMapEntry {
  /** Airtable source field name. */
  from: string;
  /** Transform raw Airtable value -> string to send (or null to omit / use fallback). */
  transform?: (raw: unknown) => string | null;
  /** Value to use when the transform yields null/empty. */
  fallback?: string;
}

/** A self-contained niche. Adding a niche = add one of these (SPEC.md §3). */
export interface NicheConfig {
  niche: string;
  airtable: {
    baseId: string;
    table: string;
    /** Airtable filterByFormula to select the active segment (optional). */
    segmentFormula?: string;
  };
  /** SmartLead lead field -> Airtable source. `email` is required. */
  fieldMap: Record<string, FieldMapEntry>;
  /** Prefix for every campaign this niche creates, e.g. "Financial Advisor: ". */
  campaignPrefix: string;
  /** Each sequence becomes its own campaign. */
  sequences: SequenceDef[];
}
