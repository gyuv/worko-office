/** Colours map to CSS variables from @worko/ui-tokens so both themes come from one source. */
const v = (n) => `var(--w-${n})`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        // Glass: surfaces are slightly see-through so the moving background shows; blur comes from .card/.glass.
        surface: 'color-mix(in srgb, var(--w-surface) 82%, transparent)', 'surface-solid': v('surface'),
        'surface-alt': 'color-mix(in srgb, var(--w-surface-alt) 75%, transparent)', border: v('border'),
        fg: v('text'), muted: v('text-muted'), primary: v('primary'), 'primary-fg': v('primary-text'),
        'primary-soft': v('primary-soft'), 'primary-strong': v('primary-strong'), accent: v('accent'),
        overdue: v('status-overdue'), 'due-soon': v('status-due-soon'), done: v('status-done'), waiting: v('status-waiting-client'),
      },
      fontSize: { xs: '12px', sm: '13px', base: '14px', lg: '16px', xl: '19px', '2xl': '23px' },
    },
  },
};
