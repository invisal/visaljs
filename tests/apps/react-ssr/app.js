// The page both programs render: a store's product listing. It has what server rendering spends
// its time on: many small components, attributes and class names, text that needs escaping,
// `style` objects, conditionals, lists with keys, and a little formatting.
import { createElement as h, Fragment } from "react";

const CATEGORIES = ["Books", "Garden & Outdoors", "Kitchen", "Toys <for kids>", "Music \"Live\""];

/** `count` products, the same on every run. */
export function makeProducts(count) {
  const products = [];
  for (let i = 0; i < count; i++) {
    products.push({
      id: i,
      name: `Product #${i} — "${["Lamp", "Chair", "Kettle", "Novel", "Drum"][i % 5]}" & co.`,
      category: CATEGORIES[i % CATEGORIES.length],
      price: 4.99 + ((i * 37) % 500) / 7,
      rating: (i * 13) % 6,
      stock: (i * 7) % 11,
      tags: ["new", "sale", "eco", "gift"].filter((_, k) => (i + k) % 3 === 0),
      description: `A <b>fine</b> item, made with care. Batch ${i % 17}, it's 'great'.`,
    });
  }
  return products;
}

function Stars({ rating }) {
  const stars = [];
  for (let i = 0; i < 5; i++) stars.push(h("span", { key: i, className: i < rating ? "star on" : "star", "aria-hidden": true }, "★"));
  return h("div", { className: "stars", title: `${rating} out of 5` }, stars);
}

function Price({ value }) {
  return h("span", { className: "price", "data-value": value }, "$", value.toFixed(2));
}

function Product({ product }) {
  const low = product.stock > 0 && product.stock < 3;
  return h("li", { className: "product", id: `p-${product.id}`, style: { order: product.id, opacity: product.stock ? 1 : 0.5 } },
    h("a", { href: `/products/${product.id}?ref=list&cat=${encodeURIComponent(product.category)}` },
      h("img", { src: `/img/${product.id}.jpg`, alt: product.name, width: 160, height: 120, loading: "lazy" })),
    h("h3", null, product.name),
    h("p", { className: "category" }, product.category),
    h(Stars, { rating: product.rating }),
    h(Price, { value: product.price }),
    product.tags.length > 0 && h("ul", { className: "tags" }, product.tags.map((t) => h("li", { key: t, className: `tag tag-${t}` }, t))),
    h("p", { className: "description" }, product.description),
    product.stock === 0
      ? h("button", { disabled: true, className: "buy" }, "Sold out")
      : h(Fragment, null,
          low && h("em", { className: "low" }, "Only ", product.stock, " left!"),
          h("button", { type: "button", className: "buy", "data-id": product.id }, "Add to cart")));
}

function Header({ title }) {
  return h("header", { className: "site-header" },
    h("a", { href: "/", className: "logo" }, title),
    h("nav", null, CATEGORIES.map((c) => h("a", { key: c, href: `/c/${encodeURIComponent(c)}` }, c))),
    h("form", { action: "/search", method: "get" },
      h("input", { type: "search", name: "q", placeholder: "Search…", defaultValue: "" }),
      h("button", { type: "submit" }, "Go")));
}

export function App({ products }) {
  return h("html", { lang: "en" },
    h("head", null,
      h("meta", { charSet: "utf-8" }),
      h("title", null, `Store — ${products.length} products`),
      h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" })),
    h("body", null,
      h(Header, { title: "The <Store>" }),
      h("main", null,
        h("h1", null, "All products"),
        h("ul", { className: "products" }, products.map((p) => h(Product, { key: p.id, product: p })))),
      h("footer", null, h("p", null, "© 2026 The Store. Prices include tax & shipping."))));
}
