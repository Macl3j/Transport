-- Umowa serwisowa, data końca leasingu, kwota wykupu
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS service_contract boolean DEFAULT false, -- umowa serwisowa: tak/nie
  ADD COLUMN IF NOT EXISTS leasing_end_date date,                   -- data końca leasingu
  ADD COLUMN IF NOT EXISTS buyout_eur       numeric(10,2);          -- kwota wykupu EUR
