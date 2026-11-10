"use client";

import { ChevronDown } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQueryParams } from "@/hooks/useQueryParams";
import { LIBRARY_ITEM_TYPES } from "@/lib/library-item-types";

const ALL = "all";

/** Narrow the library list to one kind of item, such as whole series. */
export function TypeDropdown() {
  const { updateQueryParams } = useQueryParams();
  const type = useSearchParams().get("type");
  const current = LIBRARY_ITEM_TYPES.find((t) => t.value === type);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {current?.label ?? "All types"}
          <ChevronDown className="ml-2 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={current?.value ?? ALL}
          onValueChange={(value) =>
            updateQueryParams({
              type: value === ALL ? null : value,
              page: "1",
            })
          }
        >
          <DropdownMenuRadioItem value={ALL}>All types</DropdownMenuRadioItem>
          {LIBRARY_ITEM_TYPES.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value}>
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
