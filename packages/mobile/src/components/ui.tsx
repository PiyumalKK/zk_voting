import { useEffect, useRef } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
} from "react-native";
import { colors, radii, shadows, spacing } from "../theme";

// ─── GradientButton ──────────────────────────────────────────────
// A primary action button with press animation. Falls back to a solid
// color since expo-linear-gradient may not be available in Expo Go.

interface GradientButtonProps extends TouchableOpacityProps {
  title: string;
  variant?: "primary" | "success" | "danger";
  icon?: string;
  loading?: boolean;
}

export function GradientButton({
  title,
  variant = "primary",
  icon,
  loading,
  disabled,
  style,
  ...rest
}: GradientButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const bg =
    variant === "success"
      ? colors.success
      : variant === "danger"
        ? colors.danger
        : colors.primary;

  const onPressIn = () => {
    Animated.spring(scale, {
      toValue: 0.97,
      useNativeDriver: true,
    }).start();
  };
  const onPressOut = () => {
    Animated.spring(scale, {
      toValue: 1,
      friction: 3,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <TouchableOpacity
        activeOpacity={0.85}
        disabled={disabled || loading}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          btnStyles.button,
          { backgroundColor: bg, opacity: disabled ? 0.4 : 1 },
          shadows.button,
        ]}
        {...rest}
      >
        {loading ? (
          <Text style={btnStyles.text}>⏳</Text>
        ) : (
          <Text style={btnStyles.text}>
            {icon ? `${icon}  ` : ""}
            {title}
          </Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const btnStyles = StyleSheet.create({
  button: {
    borderRadius: radii.md,
    paddingVertical: 16,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  text: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
    letterSpacing: 0.3,
  },
});

// ─── GlassCard ───────────────────────────────────────────────────
// A card with a subtle glow/glass effect.

interface GlassCardProps {
  children: React.ReactNode;
  glow?: boolean;
  glowColor?: string;
  style?: any;
}

export function GlassCard({
  children,
  glow = false,
  glowColor = colors.primary,
  style,
}: GlassCardProps) {
  return (
    <View
      style={[
        cardStyles.glass,
        glow && {
          borderColor: glowColor + "40",
          ...shadows.glow,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  glass: {
    backgroundColor: colors.card,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.card,
  },
});

// ─── StatusBadge ─────────────────────────────────────────────────
// Animated pill badge showing election phase.

const PHASE_CONFIG: Record<number, { label: string; color: string; icon: string }> = {
  0: { label: "Setup", color: colors.muted, icon: "⚙️" },
  1: { label: "Registration", color: colors.primary, icon: "📝" },
  2: { label: "Voting", color: colors.success, icon: "🗳️" },
  3: { label: "Ended", color: colors.warning, icon: "🏁" },
};

export function StatusBadge({ phase }: { phase: number }) {
  const config = PHASE_CONFIG[phase] ?? PHASE_CONFIG[0];
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (phase === 1 || phase === 2) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 0.6,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    }
  }, [phase, pulse]);

  return (
    <View style={[badgeStyles.container, { backgroundColor: config.color + "20" }]}>
      <Animated.View
        style={[
          badgeStyles.dot,
          { backgroundColor: config.color, opacity: pulse },
        ]}
      />
      <Text style={[badgeStyles.text, { color: config.color }]}>
        {config.icon} {config.label}
      </Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radii.full,
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});

// ─── StepIndicator ───────────────────────────────────────────────
// Shows progress through a multi-step flow.

interface StepIndicatorProps {
  steps: string[];
  currentStep: number; // 0-indexed
  status?: "active" | "done" | "error";
}

export function StepIndicator({ steps, currentStep, status = "active" }: StepIndicatorProps) {
  return (
    <View style={stepStyles.container}>
      {steps.map((label, i) => {
        const isDone = i < currentStep;
        const isCurrent = i === currentStep;
        const isError = isCurrent && status === "error";

        const dotColor = isDone
          ? colors.success
          : isError
            ? colors.danger
            : isCurrent
              ? colors.primary
              : colors.cardBorder;

        return (
          <View key={label} style={stepStyles.step}>
            <View style={stepStyles.dotRow}>
              <View style={[stepStyles.dot, { backgroundColor: dotColor }]}>
                {isDone && <Text style={stepStyles.dotText}>✓</Text>}
                {isError && <Text style={stepStyles.dotText}>✗</Text>}
              </View>
              {i < steps.length - 1 && (
                <View
                  style={[
                    stepStyles.line,
                    { backgroundColor: isDone ? colors.success : colors.cardBorder },
                  ]}
                />
              )}
            </View>
            <Text
              style={[
                stepStyles.label,
                {
                  color: isCurrent
                    ? colors.text
                    : isDone
                      ? colors.success
                      : colors.muted,
                  fontWeight: isCurrent ? "600" : "400",
                },
              ]}
              numberOfLines={1}
            >
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const stepStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  step: {
    flex: 1,
    alignItems: "center",
  },
  dotRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  dot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  dotText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  line: {
    flex: 1,
    height: 2,
  },
  label: {
    fontSize: 10,
    textAlign: "center",
  },
});

// ─── AnimatedSuccess ─────────────────────────────────────────────
// Fade-in + scale animation for success/failure states.

interface AnimatedResultProps {
  icon: string;
  title: string;
  subtitle?: string;
  color?: string;
}

export function AnimatedResult({
  icon,
  title,
  subtitle,
  color = colors.success,
}: AnimatedResultProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        friction: 4,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, scale]);

  return (
    <Animated.View
      style={{
        opacity,
        transform: [{ scale }],
        alignItems: "center",
        paddingVertical: spacing.xl,
      }}
    >
      <Text style={{ fontSize: 56, marginBottom: spacing.md }}>{icon}</Text>
      <Text
        style={{
          fontSize: 22,
          fontWeight: "800",
          color,
          textAlign: "center",
          marginBottom: spacing.sm,
        }}
      >
        {title}
      </Text>
      {subtitle && (
        <Text
          style={{
            fontSize: 14,
            color: colors.textSecondary,
            textAlign: "center",
            lineHeight: 22,
            maxWidth: 280,
          }}
        >
          {subtitle}
        </Text>
      )}
    </Animated.View>
  );
}

// ─── FadeIn ──────────────────────────────────────────────────────
// Wrapper that fades in its children on mount.

export function FadeIn({
  children,
  delay = 0,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: any;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 400,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 400,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY, delay]);

  return (
    <Animated.View style={[{ opacity, transform: [{ translateY }] }, style]}>
      {children}
    </Animated.View>
  );
}
