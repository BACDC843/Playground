---
name: renew-urban-design-system
description: >
  The official Renew Urban brand and design system — colors, typography, layout specs, photography direction, copy rules, and component tokens. Use this skill whenever the user asks about Renew Urban brand colors, fonts, logo usage, slide dimensions, design rules, or visual style. Also trigger when generating image prompts, graphic JSON instructions, carousel designs, ad creative, or any visual asset for Renew Urban. If the user says "use the Renew Urban design system", "follow brand guidelines", "keep it on-brand", or asks what colors/fonts/layouts Renew Urban uses — load this skill first. This skill should be used alongside the carousel builder and any content creation skill that produces visuals.
---

# Renew Urban Design System v2

Reference this whenever producing visual content, graphic prompts, or design direction for Renew Urban — carousels, ads, slides, presentations, or any marketing collateral.

---

## Brand Positioning

**Core message:** Built around what matters most.

The brand story centers on the emotional reason people build: family returning home, ordinary weekends, birthday dinners, summer visits, holidays, and the moments that become memories.

**Primary services:** Custom Homes · Historic Preservation · Luxury Renovations

**Brand tone:** Refined. Calm. Emotionally specific. Architectural. Premium. Copy should sound grounded and confident — never motivational or generic.

---

## Color Palette

| Token | Hex | Usage |
|---|---|---|
| Deep Navy | `#0B1F2E` | Primary overlay, premium backgrounds, contrast panels |
| Charcoal Blue | `#243447` | Logo wordmark tone, headings, dark UI fields |
| Coastal Blue | `#4E5D73` | Secondary backgrounds, muted text, editorial accents |
| Logo Teal | `#63C4CF` | Official roof mark accent only — use sparingly |
| Heritage Gold | `#C99A4A` | Thin rules, borders, icons, slide counters, CTA accents |
| Warm Sand | `#D8C3A5` | Soft panels, coastal warmth, tactile backgrounds |
| Stone | `#EFE9DE` | Light editorial cards and split layouts |
| Warm White | `#FAFAF8` | Primary light background and copy panels |
| Ink | `#182433` | Main text on light backgrounds |
| Muted Gray | `#6B6F73` | Secondary text |

**Color balance per slide:**
- 45–55% warm photography or warm white
- 20–30% deep navy or charcoal overlay
- 10–15% sand/stone neutrals
- 3–7% heritage gold accents
- 1–3% logo teal (logo only)

**CSS tokens:**
```css
:root {
  --navy-900: #0B1F2E;
  --navy-800: #13283A;
  --charcoal-blue: #243447;
  --coastal-blue: #4E5D73;
  --teal-logo: #63C4CF;
  --gold: #C99A4A;
  --gold-soft: #D8B36C;
  --sand: #D8C3A5;
  --stone: #EFE9DE;
  --warm-white: #FAFAF8;
  --ink: #182433;
  --muted: #6B6F73;
  --serif: Georgia, 'Times New Roman', Times, serif;
  --sans: Inter, Avenir, Montserrat, Helvetica, Arial, sans-serif;
}
```

---

## Typography

### Hero / Editorial Serif
Use for emotional carousel headlines, brand statements, large title slides.

- **Fonts:** Canela, Cormorant Garamond, Playfair Display, Libre Baskerville, Georgia (fallback)
- High contrast serif · Light to regular weight · Large scale
- Slight letter spacing · Line height: 0.9–1.08

### Body / Utility Sans
Use for service lines, captions, body text, CTA buttons, small labels, slide counters.

- **Fonts:** Montserrat, Avenir Next, Inter, Helvetica Neue, Arial (fallback)
- Clean modern sans · Body weight 400–500 · CTA weight 600–700
- Letter-spaced uppercase for small labels

---

## Logo Rules

- Use on warm white, stone, sand, or other light backgrounds whenever possible.
- Over photography: use a subtle warm-white or navy panel behind it.
- Clear space = height of the roof icon on all sides.
- Never stretch, recolor, add heavy shadows, or place over busy image areas.
- Teal is a brand mark accent only — do not use it as a dominant layout color.
- Logo panel spec: `#FAFAF8` at 94–98% opacity · padding 16–28px · `1px solid rgba(201,154,74,.35)` border.

---

## Layout System

### Full-Bleed Emotional Slide
Best for opening slides and brand storytelling.
- 1080×1350px · 4:5 ratio
- Full-bleed architectural or family-centered photography
- Navy gradient wash from left or bottom
- Large serif headline
- Thin gold border inset 24–32px
- Small gold rule under headline or between text lines
- Logo on quiet area or inside a light panel

### Split Editorial Slide
Best for design features, process explanations, service education.
- Left panel: warm white or stone copy block
- Right panel: luxury architectural image
- Serif headline in navy or charcoal · sans body copy
- Gold rule, icon, or small slide counter
- Logo near the bottom of the copy panel

### CTA Slide
Best for final carousel slide.
- Calm, premium background or stone panel
- One clear action only
- Examples: "DM BUILD" · "Schedule a conversation" · "Start with a custom home consultation"
- Logo centered or bottom-left

---

## Social Carousel Specs

| Property | Value |
|---|---|
| Dimensions | 1080×1350px |
| Ratio | 4:5 portrait |
| Safe margin | 80–110px |
| Border inset | 24–32px |

**Slide counter (when used):** Small gold or sand box · upper-left or upper-right · sans font, medium weight · e.g. `4/7`

---

## Component Tokens

**Gold Rule:** 1–2px height · 60–90px width · `#C99A4A` · use below headlines or between short copy lines.

**Border:** 1px stroke · `#C99A4A` at 60–80% opacity · inset 24–32px.

**Navy Overlay (for text on photos):**
```css
background: linear-gradient(90deg, rgba(11,31,46,.96) 0%, rgba(11,31,46,.64) 42%, rgba(201,154,74,.24) 100%);
```

---

## Photography Direction

Imagery should feel like an Architectural Digest editorial feature with a Charleston Lowcountry point of view.

**Visual themes:** Modern Lowcountry luxury · Marshfront porches · Open French doors · Candlelit dining tables · Natural oak interiors · Limestone, marble, brass, warm white walls · Historic Charleston details · Live oaks, palmettos, marsh grass, golden hour light · Family moments that feel real, not staged.

**Lighting:** Golden hour · Candlelight · Warm interior glow · Soft natural window light. Avoid harsh commercial lighting or cold blue color grading.

**Avoid:** Generic suburban homes · Cold glass-box architecture · Cartoonish renderings · Oversaturated colors · Staged stock-photo family scenes · Overcrowded text overlays.

---

## Copy System

**Headline formulas:**
- Built around [emotional outcome].
- Designed for the way [family] actually lives.
- Not just a [room]. A place for [memory].
- Where craftsmanship becomes part of the story.
- They wanted everyone to come home.

**Approved brand language:**
Built around what matters most · Building Charleston, beautifully · Custom homes · Historic preservation · Luxury renovations · Lowcountry craftsmanship · Timeless design · Coastal influence · Thoughtful process · Crafted for everyday life

**Avoid:** Generic motivational filler · "Dream home" repeated too often · Trendy design slang · Loud urgency tactics · Heavy filters · Long paragraphs on slides.

---

## Production Checklist

- Use the official Renew Urban logo.
- Keep all carousel slides at 1080×1350px.
- Serif headlines · sans body copy.
- Apply navy overlays only where text needs contrast.
- Gold accents used sparingly.
- Copy is specific and emotional.
- No clutter or generic design language.
- Every slide feels like part of the same editorial campaign.

---

## Example Carousel Copy

**Slide 1 (Hook):**
They wanted everyone to come home. Not just for holidays. For ordinary weekends. Birthday dinners. Summer visits. The moments that become memories.

**Slide 2:**
Built around what matters most. A custom home should begin with the life you want to live inside it.

**Slide 3:**
Timeless Design. Classic elements and coastal influences come together for a look that never goes out of style.

**CTA Slide:**
Start with the way you want to live. Renew Urban designs and builds custom homes, historic preservation projects, and luxury renovations throughout Charleston's most distinctive communities. DM `BUILD` to start the conversation.
