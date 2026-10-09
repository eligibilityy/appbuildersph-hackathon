"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ScanFace, UserPlus, Users, Video } from "lucide-react";
import ConnectionStatus, { useServerOnline } from "@/components/app/ConnectionStatus";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Patient view", icon: Video },
  { href: "/caregiver", label: "People", icon: Users },
  { href: "/enroll", label: "Add person", icon: UserPlus },
];

/** Top bar for the caregiver-facing pages (not the patient view). */
export default function AppHeader() {
  const pathname = usePathname();
  const online = useServerOnline();

  return (
    <header className="sticky top-0 z-40 border-b bg-card">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <Link href="/caregiver" className="flex items-center gap-2.5 rounded-lg pr-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="grid size-8 place-items-center rounded-[10px] bg-primary text-primary-foreground">
            <ScanFace className="size-[18px]" strokeWidth={2.25} />
          </span>
          <span className="hidden text-headline sm:inline">Memory Aid</span>
        </Link>

        <nav className="flex items-center gap-1" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-full px-3 text-body font-medium transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                <span className="hidden md:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <ConnectionStatus online={online} className="ml-auto" />
      </div>
    </header>
  );
}
