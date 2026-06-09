// Small inline SVG icons (16px, inherit color via currentColor).
import { SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const FolderIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M1.8 4.2c0-.6.5-1 1-1H6l1.4 1.5h5.8c.6 0 1 .4 1 1v5.6c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1V4.2Z" />
  </svg>
);

export const FileIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 1.8h4.5L12 5.3v8.9c0 .3-.2.5-.5.5h-7a.5.5 0 0 1-.5-.5V2.3c0-.3.2-.5.5-.5Z" />
    <path d="M8.4 1.9v3.4h3.4" />
  </svg>
);

export const ChevronIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);

export const SyncIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M13 2.2V5h-2.8" />
  </svg>
);

export const SplitVerticalIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2" y="2.5" width="12" height="11" rx="1" />
    <path d="M8 2.5v11" />
  </svg>
);

export const SplitHorizontalIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2" y="2.5" width="12" height="11" rx="1" />
    <path d="M2 8h12" />
  </svg>
);

export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const ExplorerIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4.5 2.5h4.2L12 5.8V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13V3a.5.5 0 0 1 .5-.5Z" />
    <path d="M8.6 2.6v3.2h3.2" />
    <path d="M6 8.7h4M6 10.7h4" />
  </svg>
);

export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="3.8" />
    <path d="M9.9 9.9 13.5 13.5" />
  </svg>
);

export const GitBranchIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="5" cy="4" r="1.5" />
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="11" cy="5" r="1.5" />
    <path d="M5 5.5v5" />
    <path d="M11 6.5q0 3-3.6 4" />
  </svg>
);

export const CollapseAllIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4.5 5 7 7l2.5-2" />
    <path d="M4.5 11 7 9l2.5 2" />
  </svg>
);

export const MinusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3.5 8h9" />
  </svg>
);

export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3.4 8.4 6.3 11.4 12.6 4.6" />
  </svg>
);

export const ArrowUpIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 13V4" />
    <path d="M4.5 7.5 8 4l3.5 3.5" />
  </svg>
);

export const MaximizeIcon = (p: SVGProps<SVGSVGElement>) => (
  // Corner brackets pointing outward — "zoom this pane to fill".
  <svg {...base(p)}>
    <path d="M6 2.5H2.5V6" />
    <path d="M10 2.5h3.5V6" />
    <path d="M13.5 10v3.5H10" />
    <path d="M6 13.5H2.5V10" />
  </svg>
);

export const RestoreIcon = (p: SVGProps<SVGSVGElement>) => (
  // Corner brackets pointing inward — "restore the split layout".
  <svg {...base(p)}>
    <path d="M2.5 6H6V2.5" />
    <path d="M13.5 6H10V2.5" />
    <path d="M10 13.5V10h3.5" />
    <path d="M6 13.5V10H2.5" />
  </svg>
);

export const GearIcon = (p: SVGProps<SVGSVGElement>) => (
  // Drawn in a 24×24 grid (Feather "settings"), rendered at 16px like the rest.
  <svg {...base({ viewBox: "0 0 24 24", strokeWidth: 1.7, ...p })}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const OpenFolderIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M1.8 4c0-.6.5-1 1-1H6l1.4 1.5h5.8c.5 0 1 .4 1 1v.8H3.4L1.8 11V4Z" />
    <path d="M3.4 7.3h11l-1.6 5c-.1.4-.5.7-1 .7H2.9c-.7 0-1.2-.7-1-1.4l1.5-4.3Z" />
  </svg>
);
