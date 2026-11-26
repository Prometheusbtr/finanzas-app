/**
 * The key the app uses to remember "this shop is this category".
 * "DOLLAR CITY RAMBLAS SA", "Dollar City  Ramblas S.A." -> "dollar city ramblas s a"
 * Tokens with 3 or more digits (store numbers, references, card endings) are dropped,
 * so "SUPER SELECTOS 0123" and "SUPER SELECTOS 0456" count as the same shop.
 */
export function merchantKey(comercio: string): string {
  return comercio
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@]+/g, " ")
    .split(" ")
    .filter((t) => t && !/\d.*\d.*\d/.test(t))
    .join(" ")
    .slice(0, 60)
    .trim();
}
