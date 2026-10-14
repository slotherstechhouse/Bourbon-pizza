import {
  Prisma,
  db,
  type PaymentMethod,
  type PaymentStatus,
  type OrderStatus,
  type PromotionKind,
} from "@workspace/db";
import { Router, type IRouter } from "express";
import {
  CreateAdminCategoryBody,
  CreateAdminProductBody,
  CreateAdminProductResponse,
  CreateAdminPromotionBody,
  GetAdminDashboardResponse,
  GetAdminReportsQueryParams,
  GetAdminReportsResponse,
  GetAdminSettingsResponse,
  ListAdminOrdersQueryParams,
  ListAdminOrdersResponse,
  ListAdminPaymentsQueryParams,
  ListAdminPaymentsResponse,
  ListAdminProductsResponse,
  ListAdminPromotionsResponse,
  ListKitchenOrdersResponse,
  RejectPaymentBody,
  RejectPaymentParams,
  RejectPaymentResponse,
  UpdateAdminCategoryBody,
  UpdateAdminCategoryParams,
  UpdateAdminCategoryResponse,
  UpdateAdminProductBody,
  UpdateAdminProductParams,
  UpdateAdminProductResponse,
  UpdateAdminPromotionBody,
  UpdateAdminPromotionParams,
  UpdateAdminPromotionResponse,
  UpdateAdminSettingsBody,
  UpdateAdminSettingsResponse,
  UpdateKitchenOrderStatusBody,
  UpdateKitchenOrderStatusParams,
  UpdateKitchenOrderStatusResponse,
  UpdateOrderStatusBody,
  UpdateOrderStatusParams,
  UpdateOrderStatusResponse,
  VerifyPaymentBody,
  VerifyPaymentParams,
  VerifyPaymentResponse,
} from "@workspace/api-zod";
import {
  getRestaurantSettings,
  orderInclude,
  productInclude,
  routingConfigured,
  toAdminOrder,
  toKitchenOrder,
  toPaymentMethod,
  toProduct,
  toPromotion,
} from "../lib/restaurant";
import { getStaffIdentity, requireStaffRoles } from "../middlewares/staffAccess";

const router: IRouter = Router();
const managementRoles = ["OWNER", "ADMIN", "MANAGER"] as const;
const orderRoles = ["OWNER", "ADMIN", "MANAGER", "CASHIER"] as const;
const paymentRoles = ["OWNER", "ADMIN", "MANAGER", "CASHIER"] as const;
const ownerAdminRoles = ["OWNER", "ADMIN"] as const;

function nowInKampala(): Date {
  const now = new Date();
  const local = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - 3 * 60 * 60 * 1000);
}

function dateAtKampalaMidnight(date: Date): Date {
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00+03:00`);
}

function nextDay(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

function normalizeCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return code || null;
}

function orderTransitionAllowed(current: string, next: string): boolean {
  const transitions: Record<string, string[]> = {
    RECEIVED: ["CONFIRMED", "CANCELLED"],
    CONFIRMED: ["PREPARING", "CANCELLED"],
    PREPARING: ["READY", "CANCELLED"],
    READY: ["OUT_FOR_DELIVERY", "COMPLETED", "CANCELLED"],
    OUT_FOR_DELIVERY: ["COMPLETED", "CANCELLED"],
    COMPLETED: [],
    CANCELLED: [],
  };
  return transitions[current]?.includes(next) ?? false;
}

function groupByLabel(
  entries: Array<{ label: string; count: number; amount: number }>,
) {
  return entries;
}

function addAudit(
  tx: Prisma.TransactionClient,
  staffUserId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Prisma.InputJsonValue,
) {
  return tx.auditLog.create({
    data: { staffUserId, action, entityType, entityId, details },
  });
}

function optionGroupCreateData(
  groups: Array<{
    name: string;
    required: boolean;
    multiple: boolean;
    minSelections?: number;
    maxSelections?: number;
    options: Array<{ name: string; priceDelta: number; available: boolean }>;
  }>,
) {
  return groups.map((group, index) => ({
    name: group.name.trim(),
    required: group.required,
    multiple: group.multiple,
    minSelections: group.minSelections ?? (group.required ? 1 : 0),
    maxSelections: group.maxSelections ?? 1,
    sortOrder: index,
    options: {
      create: group.options.map((option, optionIndex) => ({
        name: option.name.trim(),
        priceDelta: option.priceDelta,
        available: option.available,
        sortOrder: optionIndex,
      })),
    },
  }));
}

router.get(
  "/admin/dashboard",
  requireStaffRoles(...managementRoles),
  async (_req, res): Promise<void> => {
    const start = nowInKampala();
    const end = nextDay(start);
    const [
      ordersToday,
      awaitingConfirmation,
      awaitingPayment,
      preparing,
      ready,
      completed,
      cancelled,
      paidOrders,
      bestsellerGroups,
      orderEvents,
      paymentEvents,
    ] = await Promise.all([
      db.order.count({ where: { createdAt: { gte: start, lt: end } } }),
      db.order.count({ where: { orderStatus: "RECEIVED", createdAt: { gte: start, lt: end } } }),
      db.order.count({
        where: {
          paymentStatus: { in: ["AWAITING_CUSTOMER_PAYMENT", "REFERENCE_SUBMITTED", "UNDER_REVIEW"] },
          createdAt: { gte: start, lt: end },
        },
      }),
      db.order.count({ where: { orderStatus: "PREPARING", createdAt: { gte: start, lt: end } } }),
      db.order.count({ where: { orderStatus: "READY", createdAt: { gte: start, lt: end } } }),
      db.order.count({ where: { orderStatus: "COMPLETED", createdAt: { gte: start, lt: end } } }),
      db.order.count({ where: { orderStatus: "CANCELLED", createdAt: { gte: start, lt: end } } }),
      db.order.aggregate({
        where: { paymentStatus: "VERIFIED", orderStatus: { not: "CANCELLED" }, createdAt: { gte: start, lt: end } },
        _sum: { subtotal: true },
      }),
      db.orderItem.groupBy({
        by: ["nameSnapshot"],
        where: { order: { paymentStatus: "VERIFIED", createdAt: { gte: start, lt: end } } },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: "desc" } },
        take: 5,
      }),
      db.orderEvent.findMany({
        where: { createdAt: { gte: start, lt: end } },
        include: { order: { select: { reference: true } } },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      db.paymentEvent.findMany({
        where: { createdAt: { gte: start, lt: end } },
        include: { payment: { include: { order: { select: { reference: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);
    const recentActivity = [
      ...orderEvents.map((event) => ({
        description: `Order ${event.order.reference}: ${event.newStatus.toLowerCase()}${event.note ? ` — ${event.note}` : ""}`,
        createdAt: event.createdAt,
      })),
      ...paymentEvents.map((event) => ({
        description: `Payment for ${event.payment.order.reference}: ${event.newStatus.toLowerCase()}`,
        createdAt: event.createdAt,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 8);

    res.json(
      GetAdminDashboardResponse.parse({
        ordersToday,
        grossSalesToday: paidOrders._sum.subtotal ?? 0,
        awaitingConfirmation,
        awaitingPayment,
        preparing,
        ready,
        completed,
        cancelled,
        recentActivity,
        bestSellers: bestsellerGroups.map((entry) => ({
          name: entry.nameSnapshot,
          quantity: entry._sum.quantity ?? 0,
        })),
      }),
    );
  },
);

router.get(
  "/admin/orders",
  requireStaffRoles(...orderRoles),
  async (req, res): Promise<void> => {
    const parsed = ListAdminOrdersQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid order search or pagination values." });
      return;
    }
    const { q, status, page, pageSize } = parsed.data;
    const where: Prisma.OrderWhereInput = {
      ...(status ? { orderStatus: status.toUpperCase() as OrderStatus } : {}),
      ...(q
        ? {
            OR: [
              { reference: { contains: q, mode: "insensitive" } },
              { customerName: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
            ],
          }
        : {}),
    };
    const [total, orders] = await db.$transaction([
      db.order.count({ where }),
      db.order.findMany({
        where,
        include: orderInclude,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json(
      ListAdminOrdersResponse.parse({
        items: orders.map(toAdminOrder),
        total,
        page,
      }),
    );
  },
);

async function changeOrderStatus(
  orderId: string,
  nextStatus: string,
  note: string | null | undefined,
  staffUserId: string,
  kitchenOnly = false,
) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: orderInclude,
  });
  if (!order) return { error: "Order not found.", status: 404 as const };
  const target = nextStatus.toUpperCase();
  if (kitchenOnly && !["PREPARING", "READY"].includes(target)) {
    return { error: "Kitchen staff can only start preparation or mark a ticket ready.", status: 403 as const };
  }
  if (!orderTransitionAllowed(order.orderStatus, target)) {
    return { error: `Cannot move an order from ${order.orderStatus.toLowerCase()} to ${target.toLowerCase()}.`, status: 409 as const };
  }
  if (["CONFIRMED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"].includes(target) &&
      order.paymentStatus !== "VERIFIED") {
    return { error: "Verify the Mobile Money payment before accepting this order for fulfilment.", status: 409 as const };
  }
  if (target === "OUT_FOR_DELIVERY" && order.fulfillment !== "DELIVERY") {
    return { error: "Pickup orders cannot be marked out for delivery.", status: 409 as const };
  }
  if (target === "CANCELLED" && order.paymentStatus === "VERIFIED") {
    return { error: "A paid order cannot be cancelled here. Record the refund first.", status: 409 as const };
  }
  const updated = await db.$transaction(async (tx) => {
    const result = await tx.order.update({
      where: { id: order.id },
      data: { orderStatus: target as OrderStatus },
      include: orderInclude,
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        staffUserId,
        previousStatus: order.orderStatus,
        newStatus: target as OrderStatus,
        note: note?.trim() || null,
      },
    });
    await addAudit(tx, staffUserId, "order.status.updated", "order", order.id, {
      from: order.orderStatus,
      to: target,
    });
    return result;
  });
  return { updated };
}

router.patch(
  "/admin/orders/:id/status",
  requireStaffRoles(...orderRoles),
  async (req, res): Promise<void> => {
    const params = UpdateOrderStatusParams.safeParse(req.params);
    const body = UpdateOrderStatusBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid order status update." });
      return;
    }
    const result = await changeOrderStatus(
      params.data.id,
      body.data.status,
      body.data.note,
      getStaffIdentity(res).id,
    );
    if ("error" in result) {
      res.status(result.status ?? 409).json({ error: result.error });
      return;
    }
    res.json(UpdateOrderStatusResponse.parse(toAdminOrder(result.updated)));
  },
);

router.get(
  "/admin/payments",
  requireStaffRoles(...paymentRoles),
  async (req, res): Promise<void> => {
    const parsed = ListAdminPaymentsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payment filter." });
      return;
    }
    const { page, status } = parsed.data;
    const statusValue = status?.toUpperCase();
    const where: Prisma.PaymentRecordWhereInput = {
      transactionReference: { not: null },
      ...(statusValue
        ? { status: statusValue as PaymentStatus }
        : { status: { in: ["REFERENCE_SUBMITTED", "UNDER_REVIEW"] } }),
    };
    const [total, records] = await db.$transaction([
      db.paymentRecord.count({ where }),
      db.paymentRecord.findMany({
        where,
        include: { order: true },
        orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }],
        skip: (page - 1) * 30,
        take: 30,
      }),
    ]);
    res.json(
      ListAdminPaymentsResponse.parse({
        items: records
          .filter((record) => record.transactionReference !== null)
          .map((record) => ({
            id: record.id,
            orderReference: record.order.reference,
            customerName: record.order.customerName,
            phone: record.order.phone,
            amount: record.expectedAmount,
            network: record.network,
            recipient: record.recipientSnapshot,
            transactionReference: record.transactionReference!,
            status: record.status.toLowerCase(),
            submittedAt: record.submittedAt ?? record.createdAt,
          })),
        total,
        page,
      }),
    );
  },
);

async function decidePayment(
  id: string,
  body: {
    notes: string;
    confirmedAmount: number;
    confirmedRecipient: string;
    confirmedReference: string;
  },
  staffUserId: string,
  approved: boolean,
) {
  const record = await db.paymentRecord.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!record) return { error: "Payment record not found.", status: 404 as const };
  if (
    record.status !== "REFERENCE_SUBMITTED" &&
    record.status !== "UNDER_REVIEW"
  ) {
    return { error: "This payment is not awaiting review.", status: 409 as const };
  }
  if (!record.transactionReference) {
    return { error: "This payment has no transaction reference.", status: 409 as const };
  }
  if (
    approved &&
    (
      body.confirmedAmount !== record.expectedAmount ||
      body.confirmedRecipient.trim() !== record.recipientSnapshot?.trim() ||
      body.confirmedReference.trim() !== record.transactionReference.trim()
    )
  ) {
    return { error: "The actual transaction amount, recipient, and reference must exactly match the order before verification.", status: 409 as const };
  }
  const newStatus = approved ? "VERIFIED" : "REJECTED";
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.paymentRecord.update({
      where: { id },
      data: { status: newStatus },
      include: { order: true },
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: id,
        staffUserId,
        previousStatus: record.status,
        newStatus,
        notes: body.notes.trim(),
        confirmedAmount: body.confirmedAmount,
        confirmedRecipient: body.confirmedRecipient.trim(),
        confirmedReference: body.confirmedReference.trim(),
      },
    });
    await tx.order.update({
      where: { id: record.orderId },
      data: { paymentStatus: newStatus },
    });
    await addAudit(tx, staffUserId, `payment.${approved ? "verified" : "rejected"}`, "payment", id, {
      orderReference: record.order.reference,
    });
    return updated;
  });
  return { updated: result };
}

router.post(
  "/admin/payments/:id/verify",
  requireStaffRoles(...paymentRoles),
  async (req, res): Promise<void> => {
    const params = VerifyPaymentParams.safeParse(req.params);
    const body = VerifyPaymentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Enter the confirmed transaction details and review notes." });
      return;
    }
    const result = await decidePayment(
      params.data.id,
      body.data,
      getStaffIdentity(res).id,
      true,
    );
    if ("error" in result) {
      res.status(result.status ?? 409).json({ error: result.error });
      return;
    }
    res.json(
      VerifyPaymentResponse.parse({
        id: result.updated.id,
        orderReference: result.updated.order.reference,
        status: result.updated.status.toLowerCase(),
      }),
    );
  },
);

router.post(
  "/admin/payments/:id/reject",
  requireStaffRoles(...paymentRoles),
  async (req, res): Promise<void> => {
    const params = RejectPaymentParams.safeParse(req.params);
    const body = RejectPaymentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Enter review notes for this payment." });
      return;
    }
    const result = await decidePayment(
      params.data.id,
      body.data,
      getStaffIdentity(res).id,
      false,
    );
    if ("error" in result) {
      res.status(result.status ?? 409).json({ error: result.error });
      return;
    }
    res.json(
      RejectPaymentResponse.parse({
        id: result.updated.id,
        orderReference: result.updated.order.reference,
        status: result.updated.status.toLowerCase(),
      }),
    );
  },
);

router.get(
  "/admin/products",
  requireStaffRoles(...managementRoles),
  async (_req, res): Promise<void> => {
    const products = await db.product.findMany({
      where: { archivedAt: null },
      include: productInclude,
      orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    });
    res.json(ListAdminProductsResponse.parse(products.map(toProduct)));
  },
);

router.post(
  "/admin/products",
  requireStaffRoles(...managementRoles),
  async (req, res): Promise<void> => {
    const parsed = CreateAdminProductBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid menu item details." });
      return;
    }
    const body = parsed.data;
    const category = await db.category.findUnique({ where: { id: body.categoryId } });
    if (!category || category.archived) {
      res.status(422).json({ error: "Choose an active menu category." });
      return;
    }
    try {
      const product = await db.product.create({
        data: {
          categoryId: body.categoryId,
          name: body.name.trim(),
          slug: body.slug.trim().toLowerCase(),
          description: body.description.trim(),
          price: body.price,
          imageUrl: body.imageUrl ?? null,
          available: body.available,
          featured: body.featured,
          optionGroups: { create: optionGroupCreateData(body.optionGroups ?? []) },
        },
        include: productInclude,
      });
      res.status(201).json(CreateAdminProductResponse.parse(toProduct(product)));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "A menu item already uses that slug." });
        return;
      }
      throw error;
    }
  },
);

router.patch(
  "/admin/products/:id",
  requireStaffRoles(...managementRoles),
  async (req, res): Promise<void> => {
    const params = UpdateAdminProductParams.safeParse(req.params);
    const parsed = UpdateAdminProductBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid menu item update." });
      return;
    }
    const current = await db.product.findUnique({ where: { id: params.data.id } });
    if (!current) {
      res.status(404).json({ error: "Menu item not found." });
      return;
    }
    if (parsed.data.categoryId) {
      const category = await db.category.findUnique({
        where: { id: parsed.data.categoryId },
      });
      if (!category || category.archived) {
        res.status(422).json({ error: "Choose an active menu category." });
        return;
      }
    }
    try {
      const product = await db.$transaction(async (tx) => {
        if (parsed.data.optionGroups !== undefined) {
          await tx.productOptionGroup.deleteMany({ where: { productId: current.id } });
        }
        return tx.product.update({
          where: { id: current.id },
          data: {
            ...(parsed.data.categoryId ? { categoryId: parsed.data.categoryId } : {}),
            ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
            ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug.trim().toLowerCase() } : {}),
            ...(parsed.data.description !== undefined ? { description: parsed.data.description.trim() } : {}),
            ...(parsed.data.price !== undefined ? { price: parsed.data.price } : {}),
            ...(parsed.data.imageUrl !== undefined ? { imageUrl: parsed.data.imageUrl } : {}),
            ...(parsed.data.available !== undefined ? { available: parsed.data.available } : {}),
            ...(parsed.data.featured !== undefined ? { featured: parsed.data.featured } : {}),
            ...(parsed.data.archived !== undefined
              ? { archivedAt: parsed.data.archived ? new Date() : null }
              : {}),
            ...(parsed.data.optionGroups !== undefined
              ? { optionGroups: { create: optionGroupCreateData(parsed.data.optionGroups) } }
              : {}),
          },
          include: productInclude,
        });
      });
      res.json(UpdateAdminProductResponse.parse(toProduct(product)));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "A menu item already uses that slug." });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/admin/categories",
  requireStaffRoles(...managementRoles),
  async (req, res): Promise<void> => {
    const parsed = CreateAdminCategoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid category details." });
      return;
    }
    try {
      const category = await db.category.create({
        data: {
          name: parsed.data.name.trim(),
          slug: parsed.data.slug.trim().toLowerCase(),
          sortOrder: parsed.data.sortOrder,
        },
      });
      res.status(201).json({
        id: category.id,
        name: category.name,
        slug: category.slug,
        sortOrder: category.sortOrder,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "A category already uses that slug." });
        return;
      }
      throw error;
    }
  },
);

router.patch(
  "/admin/categories/:id",
  requireStaffRoles(...managementRoles),
  async (req, res): Promise<void> => {
    const params = UpdateAdminCategoryParams.safeParse(req.params);
    const parsed = UpdateAdminCategoryBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid category update." });
      return;
    }
    try {
      const category = await db.category.update({
        where: { id: params.data.id },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
          ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
          ...(parsed.data.archived !== undefined ? { archived: parsed.data.archived } : {}),
        },
      });
      res.json(
        UpdateAdminCategoryResponse.parse({
          id: category.id,
          name: category.name,
          slug: category.slug,
          sortOrder: category.sortOrder,
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        res.status(404).json({ error: "Category not found." });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/admin/promotions",
  requireStaffRoles(...managementRoles),
  async (_req, res): Promise<void> => {
    const promotions = await db.promotion.findMany({
      include: { products: true, categories: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      ListAdminPromotionsResponse.parse(
        promotions.map((promotion) => ({
          ...toPromotion(promotion),
          eligibleProductIds: promotion.products.map((entry) => entry.productId),
          eligibleCategoryIds: promotion.categories.map((entry) => entry.categoryId),
        })),
      ),
    );
  },
);

function promotionRelationCreate(
  productIds: string[],
  categoryIds: string[],
) {
  return {
    products: { create: productIds.map((productId) => ({ productId })) },
    categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
  };
}

router.post(
  "/admin/promotions",
  requireStaffRoles(...managementRoles),
  async (req, res): Promise<void> => {
    const parsed = CreateAdminPromotionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid promotion details." });
      return;
    }
    const body = parsed.data;
    if (body.kind === "percentage" && body.value > 100) {
      res.status(422).json({ error: "A percentage promotion cannot exceed 100%." });
      return;
    }
    if (body.startsAt && body.endsAt && new Date(body.startsAt) >= new Date(body.endsAt)) {
      res.status(422).json({ error: "Promotion end time must be after its start time." });
      return;
    }
    const code = normalizeCode(body.code);
    if (code && !/^[A-Z0-9_-]+$/.test(code)) {
      res.status(422).json({ error: "Promotion codes may use letters, numbers, hyphens, and underscores." });
      return;
    }
    const [products, categories] = await Promise.all([
      db.product.count({ where: { id: { in: body.eligibleProductIds ?? [] }, archivedAt: null } }),
      db.category.count({ where: { id: { in: body.eligibleCategoryIds ?? [] }, archived: false } }),
    ]);
    if (products !== new Set(body.eligibleProductIds ?? []).size ||
        categories !== new Set(body.eligibleCategoryIds ?? []).size) {
      res.status(422).json({ error: "A selected product or category is unavailable." });
      return;
    }
    try {
      const promotion = await db.promotion.create({
        data: {
          code,
          title: body.title.trim(),
          description: body.description.trim(),
          kind: body.kind.toUpperCase() as PromotionKind,
          value: body.value,
          minimumOrder: body.minimumOrder,
          usageLimit: body.usageLimit ?? null,
          active: body.active,
          startsAt: body.startsAt ? new Date(body.startsAt) : null,
          endsAt: body.endsAt ? new Date(body.endsAt) : null,
          ...promotionRelationCreate(
            body.eligibleProductIds ?? [],
            body.eligibleCategoryIds ?? [],
          ),
        },
        include: { products: true, categories: true },
      });
      res.status(201).json(
        UpdateAdminPromotionResponse.parse({
          ...toPromotion(promotion),
          eligibleProductIds: promotion.products.map((entry) => entry.productId),
          eligibleCategoryIds: promotion.categories.map((entry) => entry.categoryId),
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "That promotion code already exists." });
        return;
      }
      throw error;
    }
  },
);

router.patch(
  "/admin/promotions/:id",
  requireStaffRoles(...managementRoles),
  async (req, res): Promise<void> => {
    const params = UpdateAdminPromotionParams.safeParse(req.params);
    const parsed = UpdateAdminPromotionBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid promotion update." });
      return;
    }
    const body = parsed.data;
    if (body.kind === "percentage" && body.value !== undefined && body.value > 100) {
      res.status(422).json({ error: "A percentage promotion cannot exceed 100%." });
      return;
    }
    if (body.startsAt && body.endsAt && new Date(body.startsAt) >= new Date(body.endsAt)) {
      res.status(422).json({ error: "Promotion end time must be after its start time." });
      return;
    }
    const code = body.code === undefined ? undefined : normalizeCode(body.code);
    if (code && !/^[A-Z0-9_-]+$/.test(code)) {
      res.status(422).json({ error: "Promotion codes may use letters, numbers, hyphens, and underscores." });
      return;
    }
    try {
      const promotion = await db.$transaction(async (tx) => {
        const existing = await tx.promotion.findUnique({ where: { id: params.data.id } });
        if (!existing) throw new Prisma.PrismaClientKnownRequestError("Record not found", {
          code: "P2025", clientVersion: Prisma.prismaVersion.client,
        });
        if (body.eligibleProductIds !== undefined) {
          await tx.promotionProduct.deleteMany({ where: { promotionId: existing.id } });
        }
        if (body.eligibleCategoryIds !== undefined) {
          await tx.promotionCategory.deleteMany({ where: { promotionId: existing.id } });
        }
        return tx.promotion.update({
          where: { id: existing.id },
          data: {
            ...(code !== undefined ? { code } : {}),
            ...(body.title !== undefined ? { title: body.title.trim() } : {}),
            ...(body.description !== undefined ? { description: body.description.trim() } : {}),
            ...(body.kind !== undefined ? { kind: body.kind.toUpperCase() as PromotionKind } : {}),
            ...(body.value !== undefined ? { value: body.value } : {}),
            ...(body.minimumOrder !== undefined ? { minimumOrder: body.minimumOrder } : {}),
            ...(body.usageLimit !== undefined ? { usageLimit: body.usageLimit } : {}),
            ...(body.active !== undefined ? { active: body.active } : {}),
            ...(body.startsAt !== undefined ? { startsAt: body.startsAt ? new Date(body.startsAt) : null } : {}),
            ...(body.endsAt !== undefined ? { endsAt: body.endsAt ? new Date(body.endsAt) : null } : {}),
            ...(body.eligibleProductIds !== undefined
              ? { products: { create: body.eligibleProductIds.map((productId) => ({ productId })) } }
              : {}),
            ...(body.eligibleCategoryIds !== undefined
              ? { categories: { create: body.eligibleCategoryIds.map((categoryId) => ({ categoryId })) } }
              : {}),
          },
          include: { products: true, categories: true },
        });
      });
      res.json(
        UpdateAdminPromotionResponse.parse({
          ...toPromotion(promotion),
          eligibleProductIds: promotion.products.map((entry) => entry.productId),
          eligibleCategoryIds: promotion.categories.map((entry) => entry.categoryId),
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        res.status(404).json({ error: "Promotion not found." });
        return;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "That promotion code already exists." });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/admin/settings",
  requireStaffRoles(...ownerAdminRoles),
  async (_req, res): Promise<void> => {
    const settings = await getRestaurantSettings();
    res.json(
      GetAdminSettingsResponse.parse({
        name: settings.name,
        locationLabel: settings.locationLabel,
        address: settings.address,
        phone: settings.phone,
        whatsapp: settings.whatsapp,
        deliveryRatePerKm: settings.deliveryRatePerKm,
        deliveryEnabled: settings.deliveryEnabled,
        pickupEnabled: settings.pickupEnabled,
        deliveryConfigured: routingConfigured(settings),
        originLatitude: settings.originLatitude,
        originLongitude: settings.originLongitude,
        maximumDeliveryKm: settings.maximumDeliveryKm,
        paymentMethods: settings.paymentMethods.map(toPaymentMethod),
        openingHours: Array.isArray(settings.openingHours)
          ? settings.openingHours.filter((value): value is string => typeof value === "string")
          : [],
      }),
    );
  },
);

router.patch(
  "/admin/settings",
  requireStaffRoles(...ownerAdminRoles),
  async (req, res): Promise<void> => {
    const parsed = UpdateAdminSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid restaurant settings." });
      return;
    }
    const body = parsed.data;
    if (
      (body.originLatitude == null) !== (body.originLongitude == null)
    ) {
      res.status(422).json({ error: "Enter both restaurant map coordinates or clear both." });
      return;
    }
    if (body.deliveryEnabled && (
      body.originLatitude == null ||
      body.originLongitude == null ||
      !process.env.ROUTING_PROVIDER_URL?.trim()
    )) {
      res.status(422).json({ error: "Set the confirmed restaurant map pin and ROUTING_PROVIDER_URL before enabling delivery." });
      return;
    }
    if (body.paymentMethods) {
      const seen = new Set<string>();
      for (const method of body.paymentMethods) {
        if (seen.has(method.code)) {
          res.status(422).json({ error: "A payment method appears more than once." });
          return;
        }
        seen.add(method.code);
        if (method.enabled && !method.recipient?.trim()) {
          res.status(422).json({ error: `Add the confirmed recipient number before enabling ${method.name}.` });
          return;
        }
      }
    }
    const staffUserId = getStaffIdentity(res).id;
    const settings = await db.$transaction(async (tx) => {
      const updated = await tx.restaurantSettings.update({
        where: { id: "main" },
        data: {
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.locationLabel !== undefined ? { locationLabel: body.locationLabel.trim() } : {}),
          ...(body.address !== undefined ? { address: body.address?.trim() || null } : {}),
          ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
          ...(body.whatsapp !== undefined ? { whatsapp: body.whatsapp?.trim() || null } : {}),
          ...(body.pickupEnabled !== undefined ? { pickupEnabled: body.pickupEnabled } : {}),
          ...(body.deliveryEnabled !== undefined ? { deliveryEnabled: body.deliveryEnabled } : {}),
          ...(body.deliveryRatePerKm !== undefined ? { deliveryRatePerKm: body.deliveryRatePerKm } : {}),
          ...(body.maximumDeliveryKm !== undefined ? { maximumDeliveryKm: body.maximumDeliveryKm } : {}),
          ...(body.originLatitude !== undefined ? { originLatitude: body.originLatitude } : {}),
          ...(body.originLongitude !== undefined ? { originLongitude: body.originLongitude } : {}),
          ...(body.openingHours !== undefined
            ? { openingHours: body.openingHours as Prisma.InputJsonValue }
            : {}),
        },
      });
      for (const method of body.paymentMethods ?? []) {
        await tx.paymentMethodSetting.upsert({
          where: {
            settingsId_code: {
              settingsId: "main",
              code: method.code as PaymentMethod,
            },
          },
          create: {
            settingsId: "main",
            code: method.code as PaymentMethod,
            name: method.name.trim(),
            enabled: method.enabled,
            recipient: method.recipient?.trim() || null,
            instructions: method.instructions.trim(),
          },
          update: {
            name: method.name.trim(),
            enabled: method.enabled,
            recipient: method.recipient?.trim() || null,
            instructions: method.instructions.trim(),
          },
        });
      }
      await addAudit(tx, staffUserId, "settings.updated", "settings", updated.id, {
        changedFields: Object.keys(body),
      });
      return tx.restaurantSettings.findUniqueOrThrow({
        where: { id: "main" },
        include: { paymentMethods: { orderBy: { code: "asc" } } },
      });
    });
    res.json(
      UpdateAdminSettingsResponse.parse({
        name: settings.name,
        locationLabel: settings.locationLabel,
        address: settings.address,
        phone: settings.phone,
        whatsapp: settings.whatsapp,
        deliveryRatePerKm: settings.deliveryRatePerKm,
        deliveryEnabled: settings.deliveryEnabled,
        pickupEnabled: settings.pickupEnabled,
        deliveryConfigured: routingConfigured(settings),
        originLatitude: settings.originLatitude,
        originLongitude: settings.originLongitude,
        maximumDeliveryKm: settings.maximumDeliveryKm,
        paymentMethods: settings.paymentMethods.map(toPaymentMethod),
        openingHours: Array.isArray(settings.openingHours)
          ? settings.openingHours.filter((value): value is string => typeof value === "string")
          : [],
      }),
    );
  },
);

router.get(
  "/admin/reports",
  requireStaffRoles(...managementRoles),
  async (req, res): Promise<void> => {
    const parsed = GetAdminReportsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Select a valid report date range." });
      return;
    }
    const { from, to } = parsed.data;
    const start = dateAtKampalaMidnight(from);
    const until = nextDay(dateAtKampalaMidnight(to));
    if (start >= until) {
      res.status(400).json({ error: "The report start date must be on or before the end date." });
      return;
    }
    const dateWhere = { createdAt: { gte: start, lt: until } };
    const [
      orders,
      statusGroups,
      productGroups,
      categoryGroups,
      paymentGroups,
    ] = await Promise.all([
      db.order.findMany({
        where: { ...dateWhere, paymentStatus: { in: ["VERIFIED", "REFUNDED"] } },
        select: {
          subtotal: true,
          discount: true,
          total: true,
          paymentStatus: true,
          paymentMethod: true,
        },
      }),
      db.order.groupBy({
        by: ["orderStatus"],
        where: dateWhere,
        _count: { _all: true },
        _sum: { total: true },
      }),
      db.orderItem.groupBy({
        by: ["nameSnapshot"],
        where: {
          order: {
            ...dateWhere,
            paymentStatus: { in: ["VERIFIED", "REFUNDED"] },
          },
        },
        _count: { _all: true },
        _sum: { lineTotal: true, quantity: true },
        orderBy: { _sum: { quantity: "desc" } },
        take: 10,
      }),
      db.orderItem.groupBy({
        by: ["categorySnapshot"],
        where: {
          order: {
            ...dateWhere,
            paymentStatus: { in: ["VERIFIED", "REFUNDED"] },
          },
        },
        _count: { _all: true },
        _sum: { lineTotal: true, quantity: true },
        orderBy: { _sum: { lineTotal: "desc" } },
      }),
      db.order.groupBy({
        by: ["paymentMethod"],
        where: { ...dateWhere, paymentStatus: { in: ["VERIFIED", "REFUNDED"] } },
        _count: { _all: true },
        _sum: { total: true },
      }),
    ]);
    const grossSales = orders.reduce((sum, order) => sum + order.subtotal, 0);
    const discounts = orders.reduce((sum, order) => sum + order.discount, 0);
    const refunds = orders
      .filter((order) => order.paymentStatus === "REFUNDED")
      .reduce((sum, order) => sum + order.total, 0);
    const report = {
      orderCount: orders.length,
      grossSales,
      netSales: Math.max(0, grossSales - discounts - refunds),
      averageOrderValue: orders.length
        ? Math.round(orders.reduce((sum, order) => sum + order.total, 0) / orders.length)
        : 0,
      discounts,
      refunds,
      byStatus: groupByLabel(
        statusGroups.map((group) => ({
          label: group.orderStatus.toLowerCase(),
          count: group._count._all,
          amount: group._sum.total ?? 0,
        })),
      ),
      popularProducts: groupByLabel(
        productGroups.map((group) => ({
          label: group.nameSnapshot,
          count: group._sum.quantity ?? 0,
          amount: group._sum.lineTotal ?? 0,
        })),
      ),
      byCategory: groupByLabel(
        categoryGroups.map((group) => ({
          label: group.categorySnapshot,
          count: group._sum.quantity ?? 0,
          amount: group._sum.lineTotal ?? 0,
        })),
      ),
      byPaymentMethod: groupByLabel(
        paymentGroups.map((group) => ({
          label: group.paymentMethod,
          count: group._count._all,
          amount: group._sum.total ?? 0,
        })),
      ),
    };
    res.json(GetAdminReportsResponse.parse(report));
  },
);

router.get(
  "/kitchen/orders",
  requireStaffRoles("OWNER", "ADMIN", "MANAGER", "KITCHEN"),
  async (_req, res): Promise<void> => {
    const orders = await db.order.findMany({
      where: { orderStatus: { in: ["CONFIRMED", "PREPARING", "READY"] } },
      include: orderInclude,
      orderBy: [{ orderStatus: "asc" }, { createdAt: "asc" }],
      take: 100,
    });
    res.json(ListKitchenOrdersResponse.parse(orders.map(toKitchenOrder)));
  },
);

router.patch(
  "/kitchen/orders/:id/status",
  requireStaffRoles("OWNER", "ADMIN", "MANAGER", "KITCHEN"),
  async (req, res): Promise<void> => {
    const params = UpdateKitchenOrderStatusParams.safeParse(req.params);
    const body = UpdateKitchenOrderStatusBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid kitchen status update." });
      return;
    }
    const result = await changeOrderStatus(
      params.data.id,
      body.data.status,
      body.data.note,
      getStaffIdentity(res).id,
      true,
    );
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(UpdateKitchenOrderStatusResponse.parse(toKitchenOrder(result.updated)));
  },
);

export default router;
