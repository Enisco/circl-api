import { JobState } from '@prisma/client';
import { DemoSeedContext, putMedia, userId } from './seed-demo';
import { daysAhead, hoursAgo, seedId } from './ids';
import { reportToken } from './community';
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  MAP_ZOOM,
  staticMapKeyName,
} from '../../../src/modules/platform/commerce/services/static-map/static-map.service';
import { renderTiles } from '../../../src/modules/platform/commerce/services/static-map/tiles';

/** Section 4 (B.4). */
const STORES = [
  {
    label: 'ifeoma',
    owner: 7,
    name: 'Mama Ife African Foods',
    typeCode: 'LOCAL',
    cityId: 'LONDON',
    area: 'Peckham',
    description:
      'Yam, plantain, egusi, palm oil and the spices you cannot find in the big supermarkets. ' +
      'Family run since 2019.',
    status: 'OPEN',
    delivers: true,
    daysAgo: 170,
    heritageTags: ['WEST_AFRICAN'],
    // Peckham. Populated because this store does not hide its address, so the map has a pin (G12).
    latitude: 51.4739,
    longitude: -0.0686,
    hidesExactAddress: false,
    // Minutes from midnight. A day left out is a day closed, which is how `isOpenNow` reads it (4.4.2).
    hours: {
      MONDAY: [540, 1140],
      TUESDAY: [540, 1140],
      WEDNESDAY: [540, 1140],
      THURSDAY: [540, 1140],
      FRIDAY: [540, 1200],
      SATURDAY: [540, 1080],
    },
    items: [
      [
        'yam',
        'Puna yam, whole',
        'Sweet and firm, good for pounding or frying',
        899,
        'EACH',
        'FRESH_FROZEN',
        true,
      ],
      [
        'plantain',
        'Ripe plantain',
        'Sold in fives, ready to fry',
        350,
        'PER_PACK',
        'FRESH_FROZEN',
        true,
      ],
      [
        'egusi',
        'Ground egusi',
        'Melon seed, ground fresh weekly',
        650,
        'PER_500G',
        'FOOD_GROCERIES',
        true,
      ],
      [
        'palmoil',
        'Red palm oil',
        'One litre, unrefined',
        1200,
        'PER_LITRE',
        'FOOD_GROCERIES',
        true,
      ],
      // Out of stock, so the tile and the availableOnly filter both have something to show (B.4).
      [
        'stockfish',
        'Dried stockfish',
        'Back in next week',
        1450,
        'PER_500G',
        'FOOD_GROCERIES',
        false,
      ],
    ],
  },
  {
    label: 'grace',
    owner: 10,
    name: 'Wanjiru Home Kitchen',
    typeCode: 'LOCAL',
    cityId: 'LEEDS',
    area: 'Chapeltown',
    description: 'Kenyan home cooking, made to order. Collection only, weekends.',
    // A store on holiday, so that state renders somewhere (B.4).
    status: 'HOLIDAY',
    delivers: false,
    daysAgo: 40,
    heritageTags: ['EAST_AFRICAN'],
    // Chapeltown. A home kitchen, so the exact address is hidden and the serialiser rounds the
    // pin to about a kilometre rather than dropping the member on their own doorstep.
    latitude: 53.8175,
    longitude: -1.5289,
    hidesExactAddress: true,
    // Weekends only, as the description says.
    hours: { SATURDAY: [600, 1080], SUNDAY: [600, 960] },
    items: [
      [
        'chapati',
        'Chapati, pack of six',
        'Soft, made the morning you collect',
        500,
        'PER_PACK',
        'FOOD_GROCERIES',
        true,
      ],
      [
        'pilau',
        'Beef pilau, family size',
        'Feeds four, collection only',
        1800,
        'EACH',
        'FOOD_GROCERIES',
        true,
      ],
    ],
  },
  {
    label: 'blessing',
    owner: 3,
    name: 'Adeyemi Tailoring & Fabrics',
    typeCode: 'LOCAL',
    cityId: 'MANCHESTER',
    area: 'Moss Side',
    description:
      'Ankara by the yard, ready-to-wear and alterations while you wait. Bring a photo and we ' +
      'will cut to it.',
    status: 'OPEN',
    delivers: false,
    daysAgo: 95,
    heritageTags: ['WEST_AFRICAN'],
    latitude: 53.4517,
    longitude: -2.2506,
    hidesExactAddress: false,
    hours: {
      TUESDAY: [600, 1080],
      WEDNESDAY: [600, 1080],
      THURSDAY: [600, 1080],
      FRIDAY: [600, 1140],
      SATURDAY: [540, 1020],
    },
    items: [
      [
        'ankara6',
        'Ankara wax print, six yards',
        'Full six-yard piece, cut from the roll',
        3200,
        'EACH',
        'CLOTHING',
        true,
      ],
      [
        'lace',
        'Swiss voile lace, five yards',
        'Heavy guipure, for occasions',
        8500,
        'EACH',
        'CLOTHING',
        true,
      ],
      [
        'gele',
        'Aso oke gele',
        'Hand-woven headtie, sold on its own',
        4500,
        'EACH',
        'CLOTHING',
        true,
      ],
      [
        'kaftan',
        "Men's kaftan, ready to wear",
        'Cotton, sizes M to XXL on the rail',
        5500,
        'EACH',
        'CLOTHING',
        true,
      ],
      [
        'boubou',
        'Boubou, made to measure',
        'Two fittings, ten days from measuring',
        12000,
        'EACH',
        'CLOTHING',
        true,
      ],
      [
        'alteration',
        'Hemming and alterations',
        'Priced per hour at the machine',
        1500,
        'PER_HOUR',
        'OTHER',
        true,
      ],
      [
        'adire',
        'Adire indigo, three yards',
        'Tie-dyed in Abeokuta, no two the same',
        4200,
        'EACH',
        'CLOTHING',
        true,
      ],
      [
        'beadset',
        'Coral bead set',
        'Necklace and two bracelets, for a wedding',
        9500,
        'EACH',
        'JEWELLERY',
        true,
      ],
      [
        'babywrap',
        'Baby wrap, matching print',
        'Cut from the same roll as the six-yard',
        1800,
        'EACH',
        'BABY_KIDS',
        true,
      ],
      [
        'aslace',
        'Aso ebi set, ten pieces',
        'Ordered as a group, four weeks out',
        45000,
        'PER_PACK',
        'CLOTHING',
        false,
      ],
    ],
  },
  {
    label: 'farida',
    owner: 5,
    name: 'Rahman Beauty Supplies',
    typeCode: 'GENERAL',
    cityId: 'MANCHESTER',
    area: 'Rusholme',
    description:
      'Hair, henna and skin, on the Curry Mile. If we do not have your shade we will order it in ' +
      'for the Thursday.',
    status: 'OPEN',
    delivers: true,
    daysAgo: 60,
    heritageTags: ['SOUTH_ASIAN', 'MIDDLE_EASTERN'],
    latitude: 53.4531,
    longitude: -2.2246,
    hidesExactAddress: false,
    hours: {
      MONDAY: [600, 1200],
      TUESDAY: [600, 1200],
      WEDNESDAY: [600, 1200],
      THURSDAY: [600, 1200],
      FRIDAY: [600, 1260],
      SATURDAY: [600, 1260],
      SUNDAY: [720, 1080],
    },
    items: [
      [
        'henna',
        'Henna cones, pack of twelve',
        'Fresh stock, dated on the box',
        600,
        'PER_PACK',
        'BEAUTY_HAIR',
        true,
      ],
      [
        'shea',
        'Raw shea butter',
        'Unrefined, straight from Tamale',
        750,
        'PER_500G',
        'BEAUTY_HAIR',
        true,
      ],
      ['blackseed', 'Black seed oil', 'Cold pressed, 100ml', 950, 'EACH', 'HEALTH', true],
      [
        'braidhair',
        'Braiding hair, pre-stretched',
        'Sold per pack, eight colours on the wall',
        450,
        'PER_PACK',
        'BEAUTY_HAIR',
        true,
      ],
      [
        'edge',
        'Edge control, extra hold',
        'The one that does not flake',
        550,
        'EACH',
        'BEAUTY_HAIR',
        true,
      ],
      ['bonnet', 'Satin bonnet', 'Double lined, adult size', 400, 'EACH', 'BEAUTY_HAIR', true],
      ['argan', 'Argan hair oil', 'Moroccan, 200ml', 1100, 'EACH', 'BEAUTY_HAIR', true],
      ['kohl', 'Kohl liner', 'Traditional, ground fine', 350, 'EACH', 'BEAUTY_HAIR', true],
      [
        'attar',
        'Attar, oud blend',
        'Alcohol free, 12ml roll-on',
        2200,
        'EACH',
        'BEAUTY_HAIR',
        true,
      ],
      ['comb', 'Wide tooth comb', 'Seamless, will not snag', 300, 'EACH', 'BEAUTY_HAIR', true],
      [
        'dryer',
        'Hooded dryer, refurbished',
        'One only, tested and guaranteed six months',
        6500,
        'EACH',
        'ELECTRONICS',
        false,
      ],
    ],
  },
  {
    label: 'amara',
    owner: 1,
    name: 'Okonkwo Phone Repair',
    typeCode: 'GENERAL',
    cityId: 'MANCHESTER',
    area: 'Longsight',
    description:
      'Screens, batteries and unlocking, most done the same day. Parts have a three month ' +
      'guarantee and we will tell you when a repair is not worth it.',
    status: 'OPEN',
    delivers: false,
    daysAgo: 25,
    heritageTags: ['WEST_AFRICAN'],
    latitude: 53.4529,
    longitude: -2.1966,
    hidesExactAddress: false,
    hours: {
      MONDAY: [600, 1140],
      TUESDAY: [600, 1140],
      WEDNESDAY: [600, 1140],
      THURSDAY: [600, 1140],
      FRIDAY: [600, 1140],
      SATURDAY: [600, 1020],
    },
    items: [
      [
        'screen',
        'Phone screen replacement',
        'Most models, usually within the hour',
        6500,
        'EACH',
        'ELECTRONICS',
        true,
      ],
      [
        'battery',
        'Battery replacement',
        'Including the health check afterwards',
        3500,
        'EACH',
        'ELECTRONICS',
        true,
      ],
      [
        'charger',
        'Fast charger and cable',
        'Braided cable, two metres',
        1200,
        'EACH',
        'ELECTRONICS',
        true,
      ],
      [
        'earbuds',
        'Wireless earbuds',
        'Refurbished, six month guarantee',
        2800,
        'EACH',
        'ELECTRONICS',
        true,
      ],
      ['case', 'Shockproof case', 'Clear or black, most models', 800, 'EACH', 'ELECTRONICS', true],
      [
        'powerbank',
        'Power bank, 20000mAh',
        'Charges a phone four times over',
        2400,
        'EACH',
        'ELECTRONICS',
        true,
      ],
      [
        'simswap',
        'Unlocking and SIM swap',
        'Bring proof it is your handset',
        2000,
        'EACH',
        'OTHER',
        true,
      ],
      [
        'datarec',
        'Data recovery',
        'Quoted after we look at it, this is the deposit',
        3000,
        'EACH',
        'OTHER',
        true,
      ],
      [
        'tabletscreen',
        'Tablet screen replacement',
        'Ordered in, three to five days',
        9500,
        'EACH',
        'ELECTRONICS',
        false,
      ],
    ],
  },
  {
    label: 'aiyana',
    owner: 9,
    name: 'Aiyana Home & Prayer',
    typeCode: 'LOCAL',
    cityId: 'BIRMINGHAM',
    area: 'Small Heath',
    description:
      'Prayer mats, incense, cookware and the small things that make a flat feel like home. ' +
      'Collection or local delivery.',
    status: 'OPEN',
    delivers: true,
    daysAgo: 12,
    heritageTags: ['SOUTH_ASIAN', 'MIDDLE_EASTERN'],
    latitude: 52.4667,
    longitude: -1.8479,
    hidesExactAddress: false,
    hours: {
      MONDAY: [660, 1140],
      TUESDAY: [660, 1140],
      WEDNESDAY: [660, 1140],
      THURSDAY: [660, 1140],
      FRIDAY: [780, 1200],
      SATURDAY: [600, 1140],
    },
    items: [
      [
        'prayermat',
        'Prayer mat, padded',
        'Thick backing, folds to a quarter',
        2200,
        'EACH',
        'RELIGIOUS_CULTURAL',
        true,
      ],
      [
        'bakhoor',
        'Bakhoor and burner set',
        'Charcoal included, enough for a month',
        1600,
        'PER_PACK',
        'RELIGIOUS_CULTURAL',
        true,
      ],
      [
        'tasbih',
        'Tasbih, 99 beads',
        'Olive wood, threaded on cord',
        900,
        'EACH',
        'RELIGIOUS_CULTURAL',
        true,
      ],
      [
        'pressurepot',
        'Pressure pot, seven litre',
        'For beans and tough cuts',
        4200,
        'EACH',
        'HOME',
        true,
      ],
      [
        'mortar',
        'Mortar and pestle',
        'Granite, heavy enough to stay put',
        3200,
        'EACH',
        'HOME',
        true,
      ],
      ['teaset', 'Tea set, six glasses', 'Gold rimmed, boxed', 2600, 'PER_PACK', 'HOME', true],
      ['dates', 'Medjool dates', 'This season, soft', 850, 'PER_500G', 'FOOD_GROCERIES', true],
      [
        'zamzam',
        'Rose water',
        'For cooking or the skin, 500ml',
        500,
        'PER_LITRE',
        'FOOD_GROCERIES',
        true,
      ],
      [
        'babyset',
        'Baby gift set',
        'Blanket, hat and booties, boxed',
        1800,
        'PER_PACK',
        'BABY_KIDS',
        true,
      ],
      ['rug', 'Floor rug, two metre', 'Ordered in, choose the colour', 8500, 'EACH', 'HOME', false],
    ],
  },
];

/** Enquiries across both fulfilment modes and several states, including EXPIRED. */
const ENQUIRIES: Array<{
  label: string;
  store: string;
  buyer: number;
  state: JobState;
  fulfilment: 'DELIVERY' | 'COLLECTION';
  lines: Array<[string, number]>;
  hoursAgo: number;
}> = [
  {
    label: 'e1',
    store: 'ifeoma',
    buyer: 1,
    state: JobState.PENDING_ACCEPTANCE,
    fulfilment: 'DELIVERY',
    lines: [
      ['yam', 2],
      ['egusi', 1],
    ],
    hoursAgo: 3,
  },
  {
    label: 'e2',
    store: 'ifeoma',
    buyer: 6,
    state: JobState.ACCEPTED,
    fulfilment: 'COLLECTION',
    lines: [['plantain', 3]],
    hoursAgo: 26,
  },
  {
    label: 'e3',
    store: 'ifeoma',
    buyer: 8,
    state: JobState.COMPLETED,
    fulfilment: 'DELIVERY',
    lines: [
      ['palmoil', 1],
      ['yam', 1],
    ],
    hoursAgo: 300,
  },
  // D24: 30 days without a transition sets EXPIRED and drops it off the list.
  {
    label: 'e4',
    store: 'ifeoma',
    buyer: 9,
    state: JobState.EXPIRED,
    fulfilment: 'COLLECTION',
    lines: [['egusi', 2]],
    hoursAgo: 800,
  },
  {
    label: 'e5',
    store: 'grace',
    buyer: 1,
    state: JobState.DELIVERED,
    fulfilment: 'COLLECTION',
    lines: [
      ['chapati', 2],
      ['pilau', 1],
    ],
    hoursAgo: 60,
  },
];

export const seedCommerce = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  for (const store of STORES) {
    const id = seedId(`store:${store.label}`);
    const ownerId = userId(store.owner);
    const createdAt = hoursAgo(store.daysAgo * 24);

    const logoKey = await putMedia(ctx, {
      label: `store-logo:${store.label}`,
      uploadedById: ownerId,
      purpose: 'COMMERCE',
      kind: 'banner',
      ownerType: 'STORE_LOGO',
      ownerId: id,
      createdAt,
    });
    const coverKey = await putMedia(ctx, {
      label: `store-cover:${store.label}`,
      uploadedById: ownerId,
      purpose: 'COMMERCE',
      kind: 'banner',
      ownerType: 'STORE_COVER',
      ownerId: id,
      createdAt,
    });

    const data = {
      ownerId,
      name: store.name,
      typeCode: store.typeCode,
      description: store.description,
      area: store.area,
      cityId: store.cityId,
      status: store.status as never,
      delivers: store.delivers,
      latitude: store.latitude,
      longitude: store.longitude,
      hidesExactAddress: store.hidesExactAddress,
      logoKey,
      coverKey,
      viewCount: 40 + store.daysAgo,
      enquiryCount: ENQUIRIES.filter(row => row.store === store.label).length,
      reportToken: reportToken(`store:${store.label}`),
      createdAt,
    };

    await prisma.store.upsert({ where: { id }, update: data, create: { id, ...data } });

    // The map tile, rendered here so the demo shows one on first open rather than on the second
    // view. A store that hides its address gets none, which is the point of the flag (G12).
    if (!store.hidesExactAddress && store.latitude !== null && store.longitude !== null) {
      // The key the service itself would compute. A key invented here is one it does not
      // recognise, and the first real read would rebuild the tile it had just served.
      const mapKey = staticMapKeyName(id, store.latitude, store.longitude);

      try {
        const png = await renderTiles({
          latitude: store.latitude,
          longitude: store.longitude,
          zoom: MAP_ZOOM,
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
          tileUrl: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
          fetchTile: async url => {
            const response = await fetch(url, {
              headers: { 'User-Agent': 'circl-api/1.0 (+https://circl.app)' },
              signal: AbortSignal.timeout(10_000),
            });

            if (!response.ok) throw new Error(`tile ${response.status}`);

            return Buffer.from(await response.arrayBuffer());
          },
        });

        // Null when no tile loaded. Storing a blank grey rectangle would cache an empty map under
        // a key that never regenerates.
        if (png) {
          await ctx.storage.put(mapKey, png, 'image/png');
          await prisma.store.update({ where: { id }, data: { staticMapKey: mapKey } });
        } else {
          console.warn(`  ⚠️  Static map for ${store.name} skipped: no tiles loaded`);
        }
      } catch (error) {
        // A tile server that is unreachable must not stop the dataset seeding.
        console.warn(`  ⚠️  Static map for ${store.name} skipped: ${(error as Error).message}`);
      }
    }

    for (const code of store.heritageTags) {
      await prisma.storeHeritageTag.upsert({
        where: { storeId_code: { storeId: id, code } },
        update: {},
        create: { storeId: id, code },
      });
    }

    for (const [day, [openMinutes, closeMinutes]] of Object.entries(store.hours)) {
      await prisma.storeOpeningHours.upsert({
        where: { storeId_day: { storeId: id, day: day as never } },
        update: { openMinutes, closeMinutes },
        create: { storeId: id, day: day as never, openMinutes, closeMinutes },
      });
    }

    for (const item of store.items) {
      const [slug, name, description, price, unitCode, categoryCode, isAvailable] = item as [
        string,
        string,
        string,
        number,
        string,
        string,
        boolean,
      ];
      const itemId = seedId(`item:${store.label}:${slug}`);
      const itemData = {
        storeId: id,
        name,
        description,
        price,
        unitCode,
        categoryCode,
        isAvailable,
        viewCount: 10 + (price % 40),
        reportToken: reportToken(`item:${store.label}:${slug}`),
        createdAt,
      };

      await prisma.storeItem.upsert({
        where: { id: itemId },
        update: itemData,
        create: { id: itemId, ...itemData },
      });

      await putMedia(ctx, {
        label: `item:${store.label}:${slug}`,
        uploadedById: ownerId,
        purpose: 'COMMERCE',
        kind: 'banner',
        ownerType: 'STORE_ITEM',
        ownerId: itemId,
        createdAt,
      });
    }
  }

  for (const [index, enquiry] of ENQUIRIES.entries()) {
    const store = STORES.find(row => row.label === enquiry.store)!;
    const id = seedId(`enquiry:${enquiry.label}`);
    const createdAt = hoursAgo(enquiry.hoursAgo);

    const lines = enquiry.lines.map(([slug, quantity]) => {
      const item = store.items.find(row => row[0] === slug)! as [
        string,
        string,
        string,
        number,
        string,
        string,
        boolean,
      ];

      return {
        itemId: seedId(`item:${store.label}:${slug}`),
        name: item[1],
        quantity,
        unitPrice: item[3],
        unitCode: item[4],
      };
    });

    const data = {
      // Short and human, because it is what a buyer quotes to a seller (4.7.1).
      reference: `CRL-${String(1000 + index)}`,
      buyerId: userId(enquiry.buyer),
      storeId: seedId(`store:${store.label}`),
      sellerId: userId(store.owner),
      state: enquiry.state,
      fulfilment: enquiry.fulfilment as never,
      estimatedTotal: lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0),
      completedAt: enquiry.state === JobState.COMPLETED ? hoursAgo(enquiry.hoursAgo - 40) : null,
      expiresAt: new Date(createdAt.getTime() + 30 * 86_400_000),
      createdAt,
    };

    await prisma.enquiry.upsert({ where: { id }, update: data, create: { id, ...data } });

    for (const [lineIndex, line] of lines.entries()) {
      const lineId = seedId(`enquiry-line:${enquiry.label}:${lineIndex}`);

      await prisma.enquiryLine.upsert({
        where: { id: lineId },
        update: line,
        create: { id: lineId, enquiryId: id, ...line },
      });
    }
  }

  return {
    stores: STORES.length,
    items: STORES.reduce((total, store) => total + store.items.length, 0),
    enquiries: ENQUIRIES.length,
  };
};

export { ENQUIRIES, STORES };
