const partnerWalletRoutes = require("./routes/partnerWallet.routes");
const bookingRoutes = require("./routes/booking.routes");



app.use("/api/partner", partnerWalletRoutes);
app.use("/api/booking", bookingRoutes);
