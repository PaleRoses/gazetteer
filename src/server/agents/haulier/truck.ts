/** One scheduled departure from a city. The world's catalogue supplies these; the haulier decides nothing about when trucks run. Imports nothing, so it can sit in the actor's public signature. */
export type Truck = Readonly<{ id: string; departs: string; priceEur: number }>;
