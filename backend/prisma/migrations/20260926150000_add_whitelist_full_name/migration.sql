-- Nombre del cliente (FULLNAME de la planilla) como respaldo de client-profile
-- cuando FSM no trae identidad. Nullable: los imports v1 no lo traen.
ALTER TABLE "customer_whitelist" ADD COLUMN "full_name" TEXT;
