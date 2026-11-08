/**
 * PayPal's Acceptable Use Policy (US), as categories the contract check can point at. Each entry is a short paraphrase
 * of one item of the policy under its section heading, not PayPal's wording; the policy itself is the authority.
 *
 * Source: https://www.paypal.com/us/legalhub/paypal/acceptableuse-full (the US legal hub; /us/legalhub/acceptableuse-full
 * leads to the same policy). Retrieved 2026-11-07.
 *
 * How it was retrieved: a direct fetch of the page on 2026-11-07 was refused (HTTP 403, PayPal's bot protection), so
 * every category below was verified against search-engine excerpts of that US page taken the same day. Only items an
 * excerpt confirmed are listed; the page's own "last updated" date could not be read. Items seen only in older or
 * non-US versions (for example currency exchange, check cashing and debt settlement) are left out. Re-check the live
 * page before relying on this list beyond the hackathon.
 *
 * Note for the platform itself: the "Activities Requiring Approval" list names escrow services (under Payment
 * Facilitator). This check is about what a contract pays for; Milestone holding funds is the platform's own matter.
 */
import type { AupSection } from "@milestone/core";

export interface AupCategory {
  /** Stable id, stored on flags. */
  id: string;
  section: AupSection;
  /** Short name, as the contract page and /ops show it. */
  name: string;
  /** One-sentence paraphrase of the policy item. */
  summary: string;
}

export const PAYPAL_AUP_SOURCE = {
  url: "https://www.paypal.com/us/legalhub/paypal/acceptableuse-full",
  retrievedOn: "2026-11-07",
} as const;

export const PAYPAL_AUP_CATEGORIES: readonly AupCategory[] = [
  // ---------- Prohibited Activities ----------
  { id: "illegal_activity", section: "Prohibited Activities", name: "Illegal activity", summary: "Activity that violates any law, statute, ordinance or regulation." },
  { id: "drugs", section: "Prohibited Activities", name: "Drugs and paraphernalia", summary: "Narcotics, steroids, certain controlled substances, and drug paraphernalia." },
  { id: "weapons", section: "Prohibited Activities", name: "Firearms and ammunition", summary: "Ammunition, firearms, and certain firearm parts or accessories." },
  { id: "stolen_goods", section: "Prohibited Activities", name: "Stolen goods", summary: "Stolen goods, including digital and virtual goods." },
  { id: "sexual_content", section: "Prohibited Activities", name: "Sexually oriented material", summary: "Certain sexually oriented materials or services." },
  { id: "obscene", section: "Prohibited Activities", name: "Obscene items", summary: "Items that are considered obscene." },
  {
    id: "ip_infringement",
    section: "Prohibited Activities",
    name: "Infringing items",
    summary: "Items that infringe or violate a copyright, trademark, right of publicity or privacy, or another proprietary right.",
  },
  {
    id: "violence_discrimination",
    section: "Prohibited Activities",
    name: "Violence or discrimination",
    summary: "Engaging in, encouraging, promoting or celebrating violence, or discriminatory activity based on race, religion, disability, gender, sexual orientation or national origin.",
  },
  {
    id: "pyramid_schemes",
    section: "Prohibited Activities",
    name: "Pyramid and Ponzi schemes",
    summary: "Pyramid or Ponzi schemes, matrix programs, other \"get rich quick\" schemes, and certain multi-level marketing programs.",
  },
  {
    id: "annuities_layaway_offshore",
    section: "Prohibited Activities",
    name: "Annuities, lay-away, off-shore banking",
    summary: "Purchases of annuities or lottery contracts, lay-away systems, off-shore banking, or transactions that finance or refinance debts funded by a credit card.",
  },
  // ---------- Activities Requiring Approval ----------
  { id: "airlines", section: "Activities Requiring Approval", name: "Airlines and charters", summary: "Airlines and scheduled or non-scheduled charters, jets or air taxi operators." },
  { id: "charity", section: "Activities Requiring Approval", name: "Charities and non-profits", summary: "Collecting donations as a charity or non-profit organization." },
  {
    id: "payment_facilitator",
    section: "Activities Requiring Approval",
    name: "Payment facilitation",
    summary: "Payment services that would make the seller a money service business or electronic money institution, including the sale of stored value cards and escrow services.",
  },
  { id: "cryptocurrency", section: "Activities Requiring Approval", name: "Cryptocurrency", summary: "Cryptocurrency, including non-fungible tokens (NFTs)." },
  { id: "file_sharing", section: "Activities Requiring Approval", name: "File sharing", summary: "File sharing services, including cyberlockers and similar remote digital file sharing services." },
  {
    id: "gambling",
    section: "Activities Requiring Approval",
    name: "Gambling and prize games",
    summary: "Gambling, gaming or any other activity with an entry fee and a prize, permitted only where the operator and customers are in jurisdictions that allow it.",
  },
  {
    id: "securities",
    section: "Activities Requiring Approval",
    name: "Securities and forex",
    summary: "Buying, selling or brokering stocks, bonds, securities, options, futures, commodities, contracts for difference or forex, mutual funds or an investment interest.",
  },
  { id: "prescription", section: "Activities Requiring Approval", name: "Prescription items", summary: "Selling products that require a prescription, or prescription dispensing services." },
  { id: "telemedicine", section: "Activities Requiring Approval", name: "Telemedicine", summary: "Providing medical services and consultations remotely." },
];

const BY_ID = new Map(PAYPAL_AUP_CATEGORIES.map((c) => [c.id, c]));

export function aupCategory(id: string): AupCategory | undefined {
  return BY_ID.get(id);
}
