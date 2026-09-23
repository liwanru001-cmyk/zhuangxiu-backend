# Presentation Page Plan V1

## Layers

The presentation flow has three separate responsibilities:

1. `Presentation Document` stores project, space, product and asset facts.
2. `Presentation Page Plan` stores the theme, visible page order, page type, layout and references.
3. Reveal.js and PPT V2 render the same Document + Page Plan into different outputs.

Changing page order, hiding a page or switching a theme does not rewrite the Document.

## Page Plan shape

```json
{
  "schema_version": 1,
  "kind": "presentation_page_plan",
  "document_schema_version": 1,
  "theme_id": "modern_minimal",
  "display": {
    "show_brand": true,
    "show_price": false,
    "show_dimensions": true
  },
  "pages": [
    {
      "page_id": "page-space_design-4-hero-1",
      "source_slide_id": "space_design-4",
      "type": "space_hero",
      "layout": "space_hero_full_bleed_01",
      "space_id": "12",
      "asset_ids": ["design_document:81:rendering:v1"],
      "hidden": false,
      "order": 6
    }
  ]
}
```

Supported proposal page types are `cover`, `chapter`, `space_hero`, `space_story`,
`moodboard`, `product_feature`, `product_duo`, `product_grid` and `end`.
Project profile, client brief and whole-house plan remain available as supporting pages.

## Themes

V1 defines eight stable theme identifiers:

- `modern_minimal`
- `wabi_sabi`
- `italian_luxury`
- `modern_chinese`
- `scandinavian`
- `french_classic`
- `industrial`
- `natural_resort`

Each theme changes palette, typography, image/text proportions, spacing and product composition.

## HTTP API

- `GET /api/renovation/projects/:id/presentation-documents/:documentId/page-plan`
- `PUT /api/renovation/projects/:id/presentation-documents/:documentId/page-plan`

The PUT body may be the Page Plan itself or `{ "page_plan": { ... } }`. The server validates all
page, slide, space, asset and product references before incrementing `page_plan_version`.

## PPT V2

`POST /api/renovation/projects/:id/presentations` accepts an optional
`presentation_document_id`. When supplied, the queued job snapshots that saved Document and Page
Plan. When omitted, the server creates an in-memory Document and Page Plan snapshot from the
submitted settings. The model receives visible Page Plan pages in saved order, with stable asset
references mapped to the immutable prepared PPT asset manifest.
