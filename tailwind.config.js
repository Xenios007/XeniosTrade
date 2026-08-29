/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0f172a',
        panel: '#111827',
        border: '#1f2937',
        accent: '#38bdf8',
        success: '#22c55e',
        danger: '#f43f5e',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(56, 189, 248, 0.1), 0 18px 60px rgba(15, 23, 42, 0.55)',
      },
      backgroundImage: {
        grid: 'linear-gradient(rgba(148, 163, 184, 0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.06) 1px, transparent 1px)',
      },
    },
  },
  plugins: [],
}
