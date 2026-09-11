export function hasSearchTerms(query: string): boolean {
  return /[\p{L}\p{N}_]/u.test(query.normalize("NFKC"));
}
