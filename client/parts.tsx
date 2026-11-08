// Small pieces shared by the settings sections.
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";

export type Colors = PluginTheme["colors"];

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

export function SmallButton({ colors, label, onPress, disabled, primary, danger }: {
  colors: Colors;
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: primary ? 0 : 1,
        borderColor: danger ? colors.statusDanger : colors.border,
        backgroundColor: primary ? colors.accent : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: primary ? colors.accentForeground : danger ? colors.statusDanger : colors.foreground,
          fontSize: 12,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A monospace block with a copy button, for tokens and connection snippets. */
export function CodeBlock({ colors, text, copyLabel }: { colors: Colors; text: string; copyLabel: string }) {
  const toast = useToast();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        padding: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface2,
      }}
    >
      <Text selectable style={{ flex: 1, color: colors.foreground, fontFamily: MONO, fontSize: 12, lineHeight: 18 }}>
        {text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copyLabel}
        hitSlop={8}
        onPress={() =>
          void copyText(text).then(
            () => toast.show("Copied", { variant: "success" }),
            () => toast.error("Could not copy"),
          )
        }
      >
        <Icon name="Copy" size={14} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

export function Block({ children }: { children: ReactNode }) {
  return <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>{children}</View>;
}

