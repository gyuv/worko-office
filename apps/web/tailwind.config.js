/** Colours map to CSS variables from @worko/ui-tokens so both themes come from one source. */
const v = (n) => `var(--w-${n})`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), 'surface-alt': v('surface-alt'), border: v('border'),
        fg: v('text'), muted: v('text-muted'), primary: v('primary'), 'primary-fg': v('primary-text'),
        overdue: v('status-overdue'), 'due-soon': v('status-due-soon'), done: v('status-done'), waiting: v('status-waiting-client'),
      },
      fontSize: { xs: '11px', sm: '12px', base: '13px', lg: '15px', xl: '18px', '2xl': '22px' },
    },
  },
};
