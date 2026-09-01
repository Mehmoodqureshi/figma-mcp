// Shared demo fixture — shaped like real Figma REST/Plugin API output.
// Used by ir-example.js and codegen-example.js so both exercise the same tree.
//
// Covers: Auto Layout (V + H), padding/itemSpacing, an invisible node (dropped),
// a redundant wrapper (collapsed), TEXT with style, an INSTANCE bound to a code
// component, a VECTOR icon, and boundVariables (tokens).

export const raw = {
  id: '1:1',
  name: 'PricingCard',
  type: 'FRAME',
  visible: true,
  absoluteBoundingBox: { x: 100, y: 100, width: 320, height: 260 },
  layoutMode: 'VERTICAL',
  primaryAxisAlignItems: 'MIN',
  counterAxisAlignItems: 'MIN',
  itemSpacing: 12,
  paddingTop: 24,
  paddingRight: 24,
  paddingBottom: 24,
  paddingLeft: 24,
  cornerRadius: 16,
  layoutSizingHorizontal: 'FIXED', // 320px-wide card
  layoutSizingVertical: 'HUG', // height follows content
  fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }],
  effects: [
    { type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 4 }, radius: 20, spread: 0,
      color: { r: 0, g: 0, b: 0, a: 0.08 } },
  ],
  boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:card/bg' }] },
  children: [
    {
      id: '1:2', name: 'BadgeWrapper', type: 'GROUP', visible: true,
      absoluteBoundingBox: { x: 124, y: 124, width: 60, height: 24 },
      children: [
        {
          id: '1:3', name: 'Badge', type: 'INSTANCE', visible: true,
          componentId: 'C:badge',
          absoluteBoundingBox: { x: 124, y: 124, width: 60, height: 24 },
          cornerRadius: 999,
          layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
          fills: [{ type: 'SOLID', visible: true, color: { r: 0.39, g: 0.4, b: 0.95, a: 1 } }],
        },
      ],
    },
    {
      id: '1:4', name: 'Title', type: 'TEXT', visible: true,
      absoluteBoundingBox: { x: 124, y: 160, width: 200, height: 28 },
      layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
      characters: 'Pricing plan',
      style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 22, lineHeightPx: 28,
        letterSpacing: 0, textAlignHorizontal: 'LEFT', textCase: 'ORIGINAL' },
      fills: [{ type: 'SOLID', visible: true, color: { r: 0.07, g: 0.09, b: 0.15, a: 1 } }],
    },
    {
      id: '1:5', name: 'DebugGuide', type: 'RECTANGLE', visible: false,
      absoluteBoundingBox: { x: 124, y: 190, width: 200, height: 1 },
    },
    {
      id: '1:6', name: 'Feature', type: 'FRAME', visible: true,
      absoluteBoundingBox: { x: 124, y: 200, width: 272, height: 20 },
      layoutMode: 'HORIZONTAL', counterAxisAlignItems: 'CENTER', itemSpacing: 8,
      layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
      boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'VariableID:space/2' } },
      children: [
        {
          id: '1:7', name: 'CheckIcon', type: 'VECTOR', visible: true,
          absoluteBoundingBox: { x: 124, y: 200, width: 16, height: 16 },
          layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
          fills: [{ type: 'SOLID', visible: true, color: { r: 0.39, g: 0.4, b: 0.95, a: 1 } }],
        },
        {
          id: '1:8', name: 'Label', type: 'TEXT', visible: true,
          absoluteBoundingBox: { x: 148, y: 200, width: 220, height: 20 },
          characters: 'Pixel-verified output', layoutGrow: 1,
          layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
          style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14, lineHeightPx: 20,
            textAlignHorizontal: 'LEFT' },
          fills: [{ type: 'SOLID', visible: true, color: { r: 0.42, g: 0.45, b: 0.5, a: 1 } }],
        },
      ],
    },
  ],
};

export const variableMap = {
  'VariableID:card/bg': 'color/surface/card',
  'VariableID:space/2': 'space/2',
};

export const componentMap = {
  'C:badge': { name: 'Badge', props: { variant: 'new' } },
};
