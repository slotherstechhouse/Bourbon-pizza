import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function seed() {
  const settings = await prisma.restaurantSettings.upsert({
    where: { id: "main" },
    update: {},
    create: {
      id: "main",
      name: "Bourbon Pizza Junction",
      locationLabel: "Wandegeya, Kampala",
      openingHours: [],
      pickupEnabled: true,
      deliveryEnabled: false,
      deliveryRatePerKm: 1000,
    },
  });

  for (const method of [
    {
      code: "MTN",
      name: "MTN Mobile Money",
      instructions: "Payment details have not been confirmed by the restaurant yet.",
    },
    {
      code: "AIRTEL",
      name: "Airtel Money",
      instructions: "Payment details have not been confirmed by the restaurant yet.",
    },
  ]) {
    await prisma.paymentMethodSetting.upsert({
      where: { settingsId_code: { settingsId: settings.id, code: method.code } },
      update: {},
      create: {
        settingsId: settings.id,
        code: method.code,
        name: method.name,
        instructions: method.instructions,
        enabled: false,
      },
    });
  }

  const categories = [
    { name: "Pizza", slug: "pizza", sortOrder: 1 },
    { name: "Sides", slug: "sides", sortOrder: 2 },
  ];
  const categoryRecords = {};
  for (const category of categories) {
    categoryRecords[category.slug] = await prisma.category.upsert({
      where: { slug: category.slug },
      update: {},
      create: category,
    });
  }

  const samples = [
    {
      name: "Sample Classic Pizza",
      slug: "sample-classic-pizza",
      description: "Demonstration menu item. Replace this name, description, and price with restaurant-approved details.",
      price: 10000,
      categoryId: categoryRecords.pizza.id,
      featured: true,
    },
    {
      name: "Sample Garden Pizza",
      slug: "sample-garden-pizza",
      description: "Demonstration menu item. Replace this name, description, and price with restaurant-approved details.",
      price: 9000,
      categoryId: categoryRecords.pizza.id,
      featured: false,
    },
    {
      name: "Sample Side",
      slug: "sample-side",
      description: "Demonstration menu item. Replace this name, description, and price with restaurant-approved details.",
      price: 3000,
      categoryId: categoryRecords.sides.id,
      featured: false,
    },
  ];
  for (const sample of samples) {
    await prisma.product.upsert({
      where: { slug: sample.slug },
      update: {},
      create: {
        ...sample,
        demoLabel: "DEMO ITEM — sample price; confirm before launch",
      },
    });
  }
}

seed()
  .catch((error) => {
    console.error("Database seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
