import { validScalarFormat } from "@/lib/ai/schema-validation";

const digits: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const units: Readonly<Record<string, bigint>> = {
  十: BigInt(10),
  百: BigInt(100),
  千: BigInt(1000),
  万: BigInt(10000),
};

function decimal(value: bigint, scale: number): string | null {
  if (value < BigInt(0) || scale < 0 || scale > 4) return null;
  const text = value.toString().padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale).replace(/^0+(?=\d)/, "");
  const fraction = text.slice(text.length - scale).replace(/0+$/, "");
  const amount = fraction ? `${whole}.${fraction}` : whole;
  return /^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(amount) ? amount : null;
}

function chineseInteger(value: string): bigint | null {
  let total = BigInt(0);
  let current = BigInt(0);
  let seen = false;
  for (const character of value) {
    if (Object.hasOwn(digits, character)) {
      current = BigInt(digits[character]);
      seen = true;
      continue;
    }
    const unit = units[character];
    if (!unit) return null;
    if (character === "万") {
      total = (total + (seen ? current : BigInt(1))) * unit;
      current = BigInt(0);
      seen = false;
      continue;
    }
    total += (seen ? current : BigInt(1)) * unit;
    current = BigInt(0);
    seen = false;
  }
  return total + current;
}

/** Normalize an explicit amount without passing through a JavaScript number. */
export function parseCnAmount(text: string): string | null {
  const value = text.trim();
  const compact = value.match(
    /^(?:预算|约|大约|左右)?\s*([0-9]+(?:\.[0-9]+)?)\s*([kK])\s*(?:左右|上下)?$/u,
  );
  if (compact) {
    const [whole, fraction = ""] = compact[1].split(".");
    return decimal(BigInt(`${whole}${fraction}`) * BigInt(1000), fraction.length);
  }
  const arabic = value.match(
    /(?:预算|约|大约)?\s*(?:人民币|美元|日元|欧元|英镑|港币|￥|¥|\$|€|£)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:元|块|人民币|美元|日元|欧元|英镑|港币|CNY|USD|JPY|EUR|GBP|HKD)?\s*(?:左右|上下)?$/iu,
  );
  if (arabic && !/[kK]/.test(value)) {
    const [whole, fraction = ""] = arabic[1].split(".");
    return fraction.length <= 4 ? decimal(BigInt(`${whole}${fraction}`), fraction.length) : null;
  }
  const chinese = value.match(
    /(?:预算|约|大约)?\s*([零一二两三四五六七八九十百千万]+)\s*(?:元|块)?\s*(?:左右|上下)?$/u,
  );
  return chinese ? decimal(chineseInteger(chinese[1]) ?? -BigInt(1), 0) : null;
}

const symbols: Readonly<Record<string, string>> = {
  元: "CNY",
  块: "CNY",
  人民币: "CNY",
  "￥": "CNY",
  "¥": "CNY",
  美元: "USD",
  $: "USD",
  日元: "JPY",
  欧元: "EUR",
  "€": "EUR",
  英镑: "GBP",
  "£": "GBP",
  港币: "HKD",
};

/** Currency is assigned only when the same user span states it explicitly. */
export function parseExplicitCurrency(text: string): string | null {
  const code = text.match(/\b(CNY|USD|JPY|EUR|GBP|HKD)\b/u)?.[1];
  const named = Object.keys(symbols)
    .sort((left, right) => right.length - left.length)
    .find((item) => text.includes(item));
  const currency = code ?? (named ? symbols[named] : null);
  return currency && validScalarFormat(currency, "iso-currency") ? currency : null;
}
