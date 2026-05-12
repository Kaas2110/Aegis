/**
 * Adds weekly and yearly subscription products and packages to RevenueCat.
 * Creates products, sets test store prices, attaches to packages and entitlement.
 *
 * DO NOT reuse seedRevenueCat.ts. This is a standalone additive script.
 */

import {
  listProducts,
  listOfferings,
  listPackages,
  createProduct,
  createPackages,
  attachProductsToPackage,
  attachProductsToEntitlement,
  getProductsFromPackage,
} from '@replit/revenuecat-sdk';
import { getUncachableRevenueCatClient } from './revenueCatClient';

const PROJECT_ID = process.env.REVENUECAT_PROJECT_ID!;
const TEST_STORE_APP_ID = process.env.REVENUECAT_TEST_STORE_APP_ID!;

if (!PROJECT_ID || !TEST_STORE_APP_ID) {
  console.error('Missing REVENUECAT_PROJECT_ID or REVENUECAT_TEST_STORE_APP_ID');
  process.exit(1);
}

const TIERS = [
  {
    identifier: 'aegis_premium_weekly',
    displayName: 'Aegis Premium Weekly',
    packageIdentifier: '$rc_weekly',
    periodDuration: 'P1W',
    priceUsdMicros: 1990000, // $1.99
  },
  {
    identifier: 'aegis_premium_yearly',
    displayName: 'Aegis Premium Yearly',
    packageIdentifier: '$rc_annual',
    periodDuration: 'P1Y',
    priceUsdMicros: 34990000, // $34.99
  },
];

async function setTestStorePrice(client: any, productId: string, amountMicros: number) {
  const { data, error } = await client.post({
    url: '/projects/{project_id}/products/{product_id}/test_store_prices',
    path: { project_id: PROJECT_ID, product_id: productId },
    body: {
      prices: [{ amount_micros: amountMicros, currency: 'USD' }],
    },
  });
  if (error) throw new Error(`Failed to set test store price: ${JSON.stringify(error)}`);
  return data;
}

async function main() {
  const client = await getUncachableRevenueCatClient();

  // 1. Get existing products to avoid duplicates
  const { data: existingProducts, error: listErr } = await listProducts({
    client,
    path: { project_id: PROJECT_ID },
    query: { limit: 50 },
  });
  if (listErr) throw new Error(`Failed to list products: ${JSON.stringify(listErr)}`);

  const existingIdentifiers = new Set(existingProducts!.items.map((p: any) => p.store_identifier));

  // 2. Get current offering
  const { data: offeringsData, error: offeringsErr } = await listOfferings({
    client,
    path: { project_id: PROJECT_ID },
    query: { limit: 20 },
  });
  if (offeringsErr) throw new Error(`Failed to list offerings: ${JSON.stringify(offeringsErr)}`);

  const currentOffering = offeringsData!.items.find((o: any) => o.is_current);
  if (!currentOffering) throw new Error('No current offering found');

  console.log(`✓ Current offering: ${currentOffering.id} (${currentOffering.display_name})`);

  // 3. Get existing packages in the current offering
  const { data: packagesData, error: packagesErr } = await listPackages({
    client,
    path: { project_id: PROJECT_ID, offering_id: currentOffering.id },
    query: { limit: 20 },
  });
  if (packagesErr) throw new Error(`Failed to list packages: ${JSON.stringify(packagesErr)}`);

  const existingPackages = new Map(packagesData!.items.map((p: any) => [p.lookup_key, p]));

  // 4. Process each tier
  for (const tier of TIERS) {
    console.log(`\n--- Processing ${tier.identifier} ---`);

    // Create product if it doesn't exist
    let productId: string;
    const existing = existingProducts!.items.find((p: any) => p.store_identifier === tier.identifier);

    if (existing) {
      productId = existing.id;
      console.log(`✓ Product already exists: ${productId}`);
    } else {
      const { data: newProduct, error: createErr } = await createProduct({
        client,
        path: { project_id: PROJECT_ID },
        body: {
          store_identifier: tier.identifier,
          type: 'subscription',
          app_id: TEST_STORE_APP_ID,
          display_name: tier.displayName,
          title: tier.displayName,
          subscription: { duration: tier.periodDuration as any },
        } as any,
      });
      if (createErr) throw new Error(`Failed to create product ${tier.identifier}: ${JSON.stringify(createErr)}`);
      productId = (newProduct as any).id;
      console.log(`✓ Created product: ${productId}`);
    }

    // Set test store price
    try {
      await setTestStorePrice(client, productId, tier.priceUsdMicros);
      const price = (tier.priceUsdMicros / 1_000_000).toFixed(2);
      console.log(`✓ Set test store price: $${price}`);
    } catch (err) {
      console.warn(`⚠ Price already set or error: ${err}`);
    }

    // Create or find package
    let packageId: string;
    const existingPkg = existingPackages.get(tier.packageIdentifier);

    if (existingPkg) {
      packageId = existingPkg.id;
      console.log(`✓ Package already exists: ${packageId}`);
    } else {
      const { data: newPkg, error: pkgErr } = await createPackages({
        client,
        path: { project_id: PROJECT_ID, offering_id: currentOffering.id },
        body: {
          lookup_key: tier.packageIdentifier,
          display_name: tier.displayName,
          position: tier.packageIdentifier === '$rc_weekly' ? 0 : 2,
        } as any,
      });
      if (pkgErr) throw new Error(`Failed to create package ${tier.packageIdentifier}: ${JSON.stringify(pkgErr)}`);
      packageId = (newPkg as any).id;
      console.log(`✓ Created package: ${packageId}`);
    }

    // Check if product is already attached to the package
    const { data: pkgProducts, error: pkgProductsErr } = await getProductsFromPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: packageId },
    });
    if (pkgProductsErr) throw new Error(`Failed to get package products: ${JSON.stringify(pkgProductsErr)}`);

    const alreadyAttached = (pkgProducts as any)?.items?.some((p: any) => p.id === productId);
    if (!alreadyAttached) {
      const { error: attachErr } = await attachProductsToPackage({
        client,
        path: { project_id: PROJECT_ID, package_id: packageId },
        body: { products: [{ product_id: productId, eligibility_criteria: 'all' }] } as any,
      });
      if (attachErr) throw new Error(`Failed to attach product to package: ${JSON.stringify(attachErr)}`);
      console.log(`✓ Attached product to package`);
    } else {
      console.log(`✓ Product already attached to package`);
    }

    // Attach to entitlement (use actual entitlement ID, not lookup_key)
    const { error: entErr } = await attachProductsToEntitlement({
      client,
      path: { project_id: PROJECT_ID, entitlement_id: 'entl57d322619d' },
      body: { product_ids: [productId] } as any,
    });
    if (entErr) {
      console.warn(`⚠ Entitlement attach warning (may already be attached): ${JSON.stringify(entErr)}`);
    } else {
      console.log(`✓ Attached to entitlement "premium"`);
    }
  }

  console.log('\n✅ All subscription tiers added successfully!');
  console.log('Tiers: weekly ($1.99) · monthly (existing, $4.99) · yearly ($34.99)');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
