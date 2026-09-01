import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // xl / 2xl / 3xl 是 Tailwind 默认值（12 / 16 / 24px），不走 --radius。
        // 全站有约 880 处硬编码用它们，页面因此变成一叠圆乎乎的悬浮盒子。
        // 在这里统一收到 10–12px，比逐个改 880 个地方可靠，也一次生效。
        xl: "10px",
        "2xl": "12px",
        "3xl": "12px",
      },
      boxShadow: {
        // 扁平：阴影要么没有，要么极淡。Tailwind 默认的 md/lg/xl 在这个界面里
        // 只会让每个盒子都往前浮一层，层级反而消失。
        md: "0 1px 2px rgba(0, 0, 0, 0.04)",
        lg: "0 2px 8px rgba(0, 0, 0, 0.04)",
        xl: "0 4px 16px rgba(0, 0, 0, 0.05)",
        "2xl": "0 8px 24px rgba(0, 0, 0, 0.06)",
      },
    },
  },
  plugins: [],
};

export default config;
