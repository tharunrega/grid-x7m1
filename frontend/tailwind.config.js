/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        page: '#F4F6FA',
        card: '#FFFFFF',
        line: '#E3E8F0',
        ink: '#18212F',
        muted: '#566176',
        forecast: '#1D5FD1',
        actual: '#C2410C',
      },
      borderRadius: {
        card: '16px',
      },
      spacing: {
        card: '20px',
        grid: '16px',
      },
    },
  },
  plugins: [],
};
