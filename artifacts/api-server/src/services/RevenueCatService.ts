/**
 * Server-side RevenueCat API client for admin operations.
 * Always calls getUncachableRevenueCatClient() to get a fresh token.
 */

import { createClient } from '@replit/revenuecat-sdk/client';
import {
  listOfferings,
  listPackages,
  getProductsFromPackage,
  createProduct,
  attachProductsToPackage,
  detachProductsFromPackage,
  attachProductsToEntitlement,
  deleteProduct,
} from '@replit/revenuecat-sdk';

const PROJECT_ID = process.env.REVENUECAT_PROJECT_ID;
const TEST_STORE_APP_ID = process.env.REVENUECAT_TEST_STORE_APP_ID;

export function isRevenueCatConfigured(): boolean {
  return !!(PROJECT_ID && TEST_STORE_APP_ID);
}

async function getApiKey(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!hostname || !xReplitToken) {
    throw new Error('RevenueCat: Replit connector environment not available');
  }

  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=revenuecat`,
    {
      headers: {
        Accept: 'application/json',
        'X-Replit-Token': xReplitToken,
      },
    },
  );

  const data = (await res.json()) as { items?: Array<{ settings?: { access_token?: string; oauth?: { credentials?: { access_token?: string } } }; expires_at?: string }> };
  const connection = data.items?.[0];
  const accessToken =
    connection?.settings?.access_token ||
    connection?.settings?.oauth?.credentials?.access_token;

  if (!accessToken) throw new Error('RevenueCat: no access token from connector');
  return accessToken;
}

async function getClient() {
  const apiKey = await getApiKey();
  return createClient({
    baseUrl: 'https://api.revenuecat.com/v2',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export interface RcPackageInfo {
  packageId: string;
  offeringId: string;
  lookupKey: string;
  displayName: string;
  testStoreProduct: {
    productId: string;
    identifier: string;
    priceUsd: number | null;
    priceMicros: number | null;
  } | null;
}

export interface RcOfferingInfo {
  offeringId: string;
  offeringDisplayName: string;
  isCurrent: boolean;
  packages: RcPackageInfo[];
}

async function getTestStorePrices(client: ReturnType<typeof createClient>, productId: string): Promise<{ amount: number; amount_micros: number; currency: string }[]> {
  try {
    const { data } = await (client as any).get({
      url: '/projects/{project_id}/products/{product_id}/test_store_prices',
      path: { project_id: PROJECT_ID!, product_id: productId },
    });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function setTestStorePrice(client: ReturnType<typeof createClient>, productId: string, amountMicros: number): Promise<void> {
  await (client as any).post({
    url: '/projects/{project_id}/products/{product_id}/test_store_prices',
    path: { project_id: PROJECT_ID!, product_id: productId },
    body: { prices: [{ amount_micros: amountMicros, currency: 'USD' }] },
  });
}

export async function getOfferingInfo(): Promise<RcOfferingInfo> {
  if (!PROJECT_ID) throw new Error('REVENUECAT_PROJECT_ID not configured');

  const client = await getClient();

  const { data: offeringsData, error: offeringsErr } = await listOfferings({
    client,
    path: { project_id: PROJECT_ID },
    query: { limit: 20 },
  });
  if (offeringsErr) throw new Error(`Failed to list offerings: ${JSON.stringify(offeringsErr)}`);

  const offering = (offeringsData as any).items?.find((o: any) => o.is_current);
  if (!offering) throw new Error('No current offering found');

  const { data: packagesData, error: packagesErr } = await listPackages({
    client,
    path: { project_id: PROJECT_ID, offering_id: offering.id },
    query: { limit: 20 },
  });
  if (packagesErr) throw new Error(`Failed to list packages: ${JSON.stringify(packagesErr)}`);

  const packages: RcPackageInfo[] = [];

  for (const pkg of (packagesData as any).items ?? []) {
    const { data: productsData } = await getProductsFromPackage({
      client,
      path: {
        project_id: PROJECT_ID,
        package_id: pkg.id,
      },
    });

    const testProductItem = (productsData as any)?.items?.find(
      (item: any) => (item.product?.app_id ?? item.app_id) === TEST_STORE_APP_ID,
    );
    const testProduct = testProductItem?.product ?? (testProductItem?.app_id === TEST_STORE_APP_ID ? testProductItem : null);

    let priceInfo: RcPackageInfo['testStoreProduct'] = null;
    if (testProduct) {
      const prices = await getTestStorePrices(client, testProduct.id);
      const usdPrice = prices.find((p) => p.currency === 'USD');
      priceInfo = {
        productId: testProduct.id,
        identifier: testProduct.store_identifier,
        priceUsd: usdPrice ? usdPrice.amount / 100 : null,
        priceMicros: usdPrice ? usdPrice.amount_micros : null,
      };
    }

    packages.push({
      packageId: pkg.id,
      offeringId: offering.id,
      lookupKey: pkg.lookup_key,
      displayName: pkg.display_name ?? pkg.lookup_key,
      testStoreProduct: priceInfo,
    });
  }

  return {
    offeringId: offering.id,
    offeringDisplayName: offering.display_name ?? offering.id,
    isCurrent: true,
    packages,
  };
}

export interface UpdatePriceResult {
  ok: boolean;
  oldProductId: string | null;
  newProductId: string;
  newPriceUsd: number;
  message: string;
}

export async function updatePackagePrice(opts: {
  packageId: string;
  offeringId: string;
  newPriceUsd: number;
  periodDuration?: string;
  productIdentifierSuffix?: string;
}): Promise<UpdatePriceResult> {
  if (!PROJECT_ID || !TEST_STORE_APP_ID) {
    throw new Error('REVENUECAT_PROJECT_ID / REVENUECAT_TEST_STORE_APP_ID not configured');
  }

  const client = await getClient();
  const amountMicros = Math.round(opts.newPriceUsd * 1_000_000);

  const { data: productsData } = await getProductsFromPackage({
    client,
    path: {
      project_id: PROJECT_ID,
      package_id: opts.packageId,
    },
  });

  const oldProductItem = (productsData as any)?.items?.find(
    (item: any) => (item.product?.app_id ?? item.app_id) === TEST_STORE_APP_ID,
  );
  const oldProduct = oldProductItem?.product ?? (oldProductItem?.app_id === TEST_STORE_APP_ID ? oldProductItem : null);

  const oldIdentifier: string = oldProduct?.store_identifier ?? 'aegis_premium';
  const suffix = opts.productIdentifierSuffix ?? `_${amountMicros}`;
  const newIdentifier = `${oldIdentifier.replace(/_\d+$/, '')}${suffix}`;
  const duration = opts.periodDuration ?? oldProduct?.subscription?.duration ?? 'P1M';

  const { data: newProduct, error: createErr } = await createProduct({
    client,
    path: { project_id: PROJECT_ID },
    body: {
      store_identifier: newIdentifier,
      type: 'subscription',
      app_id: TEST_STORE_APP_ID,
      display_name: newIdentifier,
      subscription: { duration: duration as any },
    } as any,
  });

  if (createErr) throw new Error(`Failed to create new product: ${JSON.stringify(createErr)}`);
  const newProductId = (newProduct as any).id;

  await setTestStorePrice(client, newProductId, amountMicros);

  if (oldProduct) {
    const { error: detachErr } = await detachProductsFromPackage({
      client,
      path: {
        project_id: PROJECT_ID,
        package_id: opts.packageId,
      },
      body: { product_ids: [oldProduct.id] } as any,
    });
    if (detachErr) throw new Error(`Failed to detach old product: ${JSON.stringify(detachErr)}`);
  }

  const { error: attachErr } = await attachProductsToPackage({
    client,
    path: {
      project_id: PROJECT_ID,
      package_id: opts.packageId,
    },
    body: { products: [{ product_id: newProductId, eligibility_criteria: 'all' }] } as any,
  });
  if (attachErr) throw new Error(`Failed to attach new product: ${JSON.stringify(attachErr)}`);

  await attachProductsToEntitlement({
    client,
    path: { project_id: PROJECT_ID, entitlement_id: 'entl57d322619d' },
    body: { product_ids: [newProductId] } as any,
  });

  if (oldProduct) {
    const { error: delErr } = await deleteProduct({
      client,
      path: { project_id: PROJECT_ID, product_id: oldProduct.id },
    });
    if (delErr) {
      console.warn(`Could not delete old product ${oldProduct.id}: ${JSON.stringify(delErr)}`);
    }
  }

  return {
    ok: true,
    oldProductId: oldProduct?.id ?? null,
    newProductId,
    newPriceUsd: opts.newPriceUsd,
    message: `Price updated to $${opts.newPriceUsd.toFixed(2)}`,
  };
}
