import { Platform, StyleSheet } from "react-native";

/**
 * Premium dark design system for SL Vote.
 *
 * Uses a rich navy-to-deep-blue palette with accent gradients.
 * All spacing, typography, and component styles are defined here
 * so screens stay consistent.
 */

// ─── Color tokens ────────────────────────────────────────────────
export const colors = {
  // Backgrounds
  bg: "#070E1A",
  bgSecondary: "#0C1628",
  card: "#111D32",
  cardBorder: "#1E3050",
  cardGlow: "rgba(59, 130, 246, 0.08)",

  // Primary
  primary: "#3B82F6",
  primaryDark: "#2563EB",
  primaryLight: "#60A5FA",
  primaryText: "#FFFFFF",

  // Accents
  secondary: "#8B5CF6",
  accent: "#06B6D4",

  // Semantic
  success: "#10B981",
  successLight: "#34D399",
  warning: "#F59E0B",
  warningLight: "#FBBF24",
  danger: "#EF4444",
  dangerLight: "#F87171",

  // Text
  text: "#F1F5F9",
  textSecondary: "#CBD5E1",
  muted: "#64748B",

  // Gradient pairs (for LinearGradient)
  gradientPrimary: ["#60A5FA", "#3B82F6", "#6366F1"] as const,
  gradientSuccess: ["#34D399", "#10B981", "#059669"] as const,
  gradientDanger: ["#F87171", "#EF4444", "#DC2626"] as const,
  gradientCard: ["rgba(23, 37, 63, 0.95)", "rgba(13, 22, 40, 0.98)"] as const,
  gradientHeader: ["#0C1628", "#070E1A"] as const,
};

// ─── Spacing tokens ──────────────────────────────────────────────
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

// ─── Border radius ───────────────────────────────────────────────
export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
};

// ─── Shadows ─────────────────────────────────────────────────────
export const shadows = {
  card: Platform.select({
    ios: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
    },
    android: { elevation: 6 },
  }),
  button: Platform.select({
    ios: {
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.4,
      shadowRadius: 14,
    },
    android: { elevation: 8 },
  }),
  glow: Platform.select({
    ios: {
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.35,
      shadowRadius: 28,
    },
    android: { elevation: 4 },
  }),
};

// ─── Shared styles ───────────────────────────────────────────────
export const styles = StyleSheet.create({
  // Screens
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    padding: spacing.lg,
  },

  // Typography
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: colors.text,
    marginBottom: spacing.sm,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: colors.muted,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },

  // Cards
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.card,
  },
  cardElevated: {
    backgroundColor: colors.card,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.primary + "30",
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.glow,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.sm,
  },
  cardText: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
  },

  // Buttons
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: spacing.sm,
    ...shadows.button,
  },
  buttonText: {
    color: colors.primaryText,
    fontWeight: "700",
    fontSize: 16,
    letterSpacing: 0.3,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonOutline: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    borderRadius: radii.md,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  buttonOutlineText: {
    color: colors.textSecondary,
    fontWeight: "600",
    fontSize: 15,
  },
  buttonDanger: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: colors.danger + "40",
    borderRadius: radii.md,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: spacing.sm,
  },

  // Inputs
  input: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    borderRadius: radii.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 16,
    marginBottom: spacing.md,
  },

  // Utility
  mono: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: colors.textSecondary,
    fontSize: 12,
  },
  badge: {
    alignSelf: "flex-start",
    borderRadius: radii.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: spacing.sm,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  label: {
    fontSize: 11,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.xs,
    fontWeight: "600",
  },
  divider: {
    height: 1,
    backgroundColor: colors.cardBorder,
    marginVertical: spacing.md,
  },

  // Row layout
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
});
