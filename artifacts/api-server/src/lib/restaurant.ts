import { Prisma, db, type PaymentMethod } from "@workspace/db";

export const productInclude = {
  category: true,
  optionGroups: {
    orderBy: { sortOrder: "asc" },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  },
} satisfies Prisma.ProductInclude;

export type ProductWithMenu = Prisma.ProductGetPayload<{
  include: typeof productInclude;
}>;

export const orderInclude = {
  items: { orderBy: { id: "asc" } },
  payments: { orderBy: { createdAt: "desc" }, take: 1 },
} satisfies Prisma.OrderInclude;

export type OrderWithItems = Prisma.OrderGetPayload<{
  include: typeof orderInclude;
}>;

export const settingsInclude = {
  paymentMethods: { orderBy: { code: "asc" } },
} satisfies Prisma.RestaurantSettingsInclude;

export type SettingsWithPayments = Prisma.RestaurantSettingsGetPayload<{
  include: typeof settingsInclude;
}>;

export function toProduct(product: ProductWithMenu) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    price: product.price,
    imageUrl: product.imageUrl,
    available: product.available && product.archivedAt === null,
    featured: product.featured,
    demoLabel: product.demoLabel,
    category: {
      id: product.category.id,
      name: product.category.name,
      slug: product.category.slug,
      sortOrder: product.category.sortOrder,
    },
    optionGroups: product.optionGroups.map((group) => ({
      id: group.id,
      name: group.name,
      required: group.required,
      multiple: group.multiple,
      minSelections: group.minSelections,
      maxSelections: group.maxSelections,
      options: group.options.map((option) => ({
        id: option.id,
        name: option.name,
        priceDelta: option.priceDelta,
        available: option.available,
      })),
    })),
  };
}

export function lower(value: string): string {
  return value.toLowerCase();
}

export function toOrderItem(item: OrderWithItems["items"][number]) {
  const options = Array.isArray(item.optionsSnapshot)
    ? item.optionsSnapshot
    : [];
  return {
    name: item.nameSnapshot,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    lineTotal: item.lineTotal,
    options: options.map((option) => {
      if (typeof option === "object" && option !== null && "name" in option) {
        const name = (option as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
      }
      return "";
    }).filter(Boolean),
    instructions: item.instructions ?? "",
  };
}

export function toPublicOrder(order: OrderWithItems, paymentInstructions: string) {
  return {
    reference: order.reference,
    customerName: order.customerName,
    fulfillment: lower(order.fulfillment),
    paymentMethod: order.paymentMethod,
    paymentStatus: lower(order.paymentStatus),
    orderStatus: lower(order.orderStatus),
    items: order.items.map(toOrderItem),
    subtotal: order.subtotal,
    discount: order.discount,
    deliveryDistanceKm:
      order.deliveryDistanceM === null
        ? null
        : Math.round((order.deliveryDistanceM / 1000) * 100) / 100,
    deliveryFee: order.deliveryFee,
    total: order.total,
    createdAt: order.createdAt,
    paymentInstructions,
  };
}

export function toAdminOrder(order: OrderWithItems) {
  return {
    id: order.id,
    reference: order.reference,
    customerName: order.customerName,
    phone: order.phone,
    fulfillment: lower(order.fulfillment),
    paymentMethod: order.paymentMethod,
    paymentStatus: lower(order.paymentStatus),
    orderStatus: lower(order.orderStatus),
    items: order.items.map(toOrderItem),
    subtotal: order.subtotal,
    discount: order.discount,
    deliveryFee: order.deliveryFee,
    total: order.total,
    createdAt: order.createdAt,
    address: order.address,
    instructions: order.specialInstructions,
  };
}

export function toKitchenOrder(order: OrderWithItems) {
  return {
    id: order.id,
    reference: order.reference,
    fulfillment: lower(order.fulfillment),
    orderStatus: lower(order.orderStatus),
    items: order.items.map(toOrderItem),
    createdAt: order.createdAt,
    instructions: order.specialInstructions ?? "",
  };
}

export function toPromotion(promotion: {
  id: string;
  code: string | null;
  title: string;
  description: string;
  kind: string;
  value: number;
  minimumOrder: number;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}) {
  return {
    id: promotion.id,
    code: promotion.code,
    title: promotion.title,
    description: promotion.description,
    kind: lower(promotion.kind),
    value: promotion.value,
    minimumOrder: promotion.minimumOrder,
    active: promotion.active,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
  };
}

export function toPaymentMethod(method: {
  code: PaymentMethod;
  name: string;
  enabled: boolean;
  instructions: string;
  recipient: string | null;
}) {
  return {
    code: method.code,
    name: method.name,
    enabled: method.enabled && Boolean(method.recipient?.trim()),
    instructions: method.instructions,
    recipient: method.enabled ? method.recipient : null,
  };
}

export async function getRestaurantSettings(): Promise<SettingsWithPayments> {
  const settings = await db.restaurantSettings.findUnique({
    where: { id: "main" },
    include: settingsInclude,
  });
  if (!settings) {
    throw new Error("Restaurant settings have not been initialized.");
  }
  return settings;
}

export function routingConfigured(
  settings: Pick<
    SettingsWithPayments,
    "originLatitude" | "originLongitude" | "deliveryEnabled"
  >,
): boolean {
  return (
    settings.originLatitude !== null &&
    settings.originLongitude !== null &&
    Boolean(process.env.ROUTING_PROVIDER_URL?.trim())
  );
}

export async function getDrivingDistanceMeters(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
): Promise<number> {
  const configuredBase = process.env.ROUTING_PROVIDER_URL?.trim();
  if (!configuredBase) {
    throw new Error("Delivery routing has not been configured.");
  }

  const baseUrl = new URL(configuredBase);
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("The routing provider URL must use HTTP or HTTPS.");
  }
  const routeUrl = new URL(
    `route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`,
    configuredBase.endsWith("/") ? configuredBase : `${configuredBase}/`,
  );
  routeUrl.searchParams.set("overview", "false");
  routeUrl.searchParams.set("alternatives", "false");
  routeUrl.searchParams.set("steps", "false");

  const response = await fetch(routeUrl, {
    signal: AbortSignal.timeout(8000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Routing provider returned HTTP ${response.status}.`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("code" in result) ||
    result.code !== "Ok" ||
    !("routes" in result) ||
    !Array.isArray(result.routes) ||
    result.routes.length === 0
  ) {
    throw new Error("No driving route was returned for that destination.");
  }
  const distance = (result.routes[0] as { distance?: unknown }).distance;
  if (typeof distance !== "number" || !Number.isFinite(distance) || distance <= 0) {
    throw new Error("The routing provider returned an invalid distance.");
  }
  return Math.ceil(distance);
}

export function calculateDeliveryFee(distanceMeters: number, ratePerKm: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    throw new Error("Route distance must be a positive number of metres.");
  }
  if (!Number.isSafeInteger(ratePerKm) || ratePerKm < 0) {
    throw new Error("Delivery rate must be a non-negative whole UGX amount.");
  }
  return Math.ceil(distanceMeters / 1000) * ratePerKm;
}

