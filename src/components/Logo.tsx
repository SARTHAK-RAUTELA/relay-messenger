/** Relay mark: a looping "R" with a relay tail on a pine tile. Original artwork. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#2c5048" />
      <path d="M9 21.5V10.5h7.2a4.3 4.3 0 0 1 0 8.6H12" fill="none" stroke="#f2c14e" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.5 19.1l5 4.4" stroke="#f2c14e" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
