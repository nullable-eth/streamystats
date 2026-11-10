/** The item types the library list can be narrowed to. */
export const LIBRARY_ITEM_TYPES = [
  { value: "Movie", label: "Movies" },
  { value: "Series", label: "Series" },
  { value: "Episode", label: "Episodes" },
] as const;

export type LibraryItemType = (typeof LIBRARY_ITEM_TYPES)[number]["value"];

/** The type a URL asks for, if it is one the list can be narrowed to. */
export function libraryItemType(
  value: string | undefined,
): LibraryItemType | undefined {
  return LIBRARY_ITEM_TYPES.find((t) => t.value === value)?.value;
}
