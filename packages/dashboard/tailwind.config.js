/** @type {import('tailwindcss').Config} */
export default {
  content: {
    relative: true,
    files: ['./index.html', './src/**/*.{ts,tsx}'],
  },
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['var(--ak-sans-font)'],
        mono: ['var(--ak-mono-font)'],
      },
      fontSize: {
        caption: ['var(--ak-type-caption-size)', { lineHeight: 'var(--ak-type-caption-leading)' }],
        meta: ['var(--ak-type-meta-size)', { lineHeight: 'var(--ak-type-meta-leading)' }],
        ui: ['var(--ak-type-ui-size)', { lineHeight: 'var(--ak-type-ui-leading)' }],
        'ui-emphasis': ['var(--ak-type-ui-size)', { lineHeight: 'var(--ak-type-ui-leading)', fontWeight: '600' }],
        body: ['var(--ak-type-body-size)', { lineHeight: 'var(--ak-type-body-leading)' }],
        title: ['var(--ak-type-title-size)', { lineHeight: 'var(--ak-type-title-leading)', fontWeight: '600' }],
        heading: ['var(--ak-type-heading-size)', { lineHeight: 'var(--ak-type-heading-leading)', fontWeight: '600' }],
        code: ['var(--ak-type-code-size)', { lineHeight: 'var(--ak-type-code-leading)' }],
      },
    },
  },
  plugins: [],
}
