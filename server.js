require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();

/* ==========================================================================
   INIZIALIZZAZIONE SERVIZI CLOUD
   ========================================================================== */

// 1. Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 2. Twilio (Opzionale)
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Helper function per l'invio sicuro di Notifiche via Twilio (SMS / WhatsApp)
async function sendTwilioNotification(toPhone, messageBody) {
  if (!twilioClient || !toPhone) return;
  try {
    await twilioClient.messages.create({
      body: messageBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toPhone
    });
    console.log(`[Twilio Notifica Inviata] -> ${toPhone}`);
  } catch (err) {
    console.error(`[Twilio Errore] -> Impossibile inviare a ${toPhone}:`, err.message);
  }
}

// 3. Stripe (Opzionale)
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

/* ==========================================================================
   WEBHOOK STRIPE (TASSATIVAMENTE PRIMA DI express.json())
   ========================================================================== */
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(400).send('Stripe non configurato.');
    }

    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      // req.body è il Buffer grezzo non alterato da express.json()
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error(`Errore firma Webhook: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gestione dell'evento Pagamento Completato
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const bookingId = session.metadata?.booking_id;

      if (!bookingId) {
        console.error('Webhook Errore: booking_id mancante nei metadata');
        return res.json({ received: true });
      }

      try {
        // 1. Aggiorna lo stato della prenotazione a "confirmed"
        const { data: booking, error: bookingErr } = await supabase
          .from('bookings')
          .update({ status: 'confirmed' })
          .eq('id', bookingId)
          .select(`
            *,
            family:users!bookings_family_id_fkey ( full_name, phone ),
            sitter:users!bookings_sitter_id_fkey ( full_name, phone )
          `)
          .single();

        if (bookingErr) throw bookingErr;

        // 2. Aggiorna lo stato dello slot collegato a "booked"
        if (booking && booking.slot_id) {
          await supabase
            .from('slots')
            .update({ status: 'booked' })
            .eq('id', booking.slot_id);
        }

        // 3. Invia notifiche SMS di avvenuto pagamento a entrambi gli utenti
        if (booking) {
          if (booking.family?.phone) {
            await sendTwilioNotification(
              booking.family.phone,
              `BabyApp: Pagamento della caparra confermato! La tua prenotazione con ${booking.sitter?.full_name || 'la babysitter'} per il ${booking.booking_date} è ufficialmente confermata.`
            );
          }
          if (booking.sitter?.phone) {
            await sendTwilioNotification(
              booking.sitter.phone,
              `BabyApp: La famiglia ${booking.family?.full_name || ''} ha versato la caparra. Il servizio per il ${booking.booking_date} è confermato!`
            );
          }
        }

        console.log(`Prenotazione ${bookingId} confermata e pagata con successo via Stripe!`);
      } catch (err) {
        console.error(`Errore durante aggiornamento DB da Webhook: ${err.message}`);
      }
    }

    res.json({ received: true });
  }
);

/* ==========================================================================
   MIDDLEWARE GLOBALI (ESECUTI SOLO DOPO LA ROTTA WEBHOOK)
   ========================================================================== */
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

/* ==========================================================================
   ROTTE BASE & AUTENTICAZIONE
   ========================================================================== */

app.get('/', (req, res) => {
  res.send('<h1>Server BabyApp Attivo!</h1><p>Le API rispondono su /api/slots</p>');
});

// Registrazione
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, phone, role } = req.body;

  try {
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) throw authError;

    const { error: dbError } = await supabase.from('users').insert([
      {
        id: authData.user.id,
        email,
        full_name,
        phone,
        role: role || 'family',
      },
    ]);

    if (dbError) throw dbError;

    res.status(201).json({ success: true, message: 'Registrazione completata!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    res.json({
      success: true,
      token: data.session.access_token,
      user: profile,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   DISPONIBILITÀ (SLOTS)
   ========================================================================== */

// GET: Recupera gli slot (Sitter: i propri slot | Famiglia: gli slot aperti)
app.get('/api/slots', async (req, res) => {
  const { sitter_id } = req.query;

  try {
    let query = supabase.from('slots').select(`
      id,
      slot_date,
      time_slot,
      hourly_rate,
      status,
      sitter_id,
      created_at,
      users ( full_name, phone )
    `);

    if (sitter_id) {
      query = query.eq('sitter_id', sitter_id);
    } else {
      query = query.or('status.eq.open,status.eq.available,status.eq.AVAILABLE,status.is.null');
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Aggiungi un nuovo slot (Babysitter)
app.post('/api/slots', async (req, res) => {
  const { sitter_id, slot_date, time_slot, hourly_rate } = req.body;

  if (!sitter_id || !slot_date || !time_slot || !hourly_rate) {
    return res.status(400).json({ success: false, error: 'Tutti i campi sono obbligatori.' });
  }

  try {
    const { data, error } = await supabase
      .from('slots')
      .insert([
        {
          sitter_id,
          slot_date,
          time_slot,
          hourly_rate: parseFloat(hourly_rate),
          status: 'open'
        }
      ])
      .select();

    if (error) {
      console.error("Errore inserimento slot Supabase:", error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error("Errore server:", err);
    res.json({ success: false, error: 'Errore interno del server.' });
  }
});

// PUT: Modifica un'esistente disponibilità (Babysitter)
app.put('/api/slots/:id', async (req, res) => {
  const { id } = req.params;
  const { slot_date, time_slot, hourly_rate } = req.body;

  try {
    const { data: slot, error: fetchError } = await supabase
      .from('slots')
      .select('status')
      .eq('id', id)
      .single();

    if (fetchError || !slot) {
      return res.status(404).json({ success: false, error: 'Slot non trovato.' });
    }

    if (slot.status === 'booked' || slot.status === 'pending') {
      return res.status(400).json({ 
        success: false, 
        error: 'Impossibile modificare uno slot con prenotazioni in corso o confermate.' 
      });
    }

    const { data, error } = await supabase
      .from('slots')
      .update({
        slot_date,
        time_slot,
        hourly_rate: parseFloat(hourly_rate)
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE: Elimina uno slot libero (Babysitter)
app.delete('/api/slots/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: slot, error: fetchError } = await supabase
      .from('slots')
      .select('status')
      .eq('id', id)
      .single();

    if (fetchError || !slot) {
      return res.status(404).json({ success: false, error: 'Slot non trovato.' });
    }

    if (slot.status === 'booked' || slot.status === 'pending') {
      return res.status(400).json({ 
        success: false, 
        error: 'Impossibile eliminare uno slot con prenotazioni in corso o confermate.' 
      });
    }

    const { error } = await supabase
      .from('slots')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Slot eliminato con successo.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   PRENOTAZIONI & NOTIFICHE SMS/WHATSAPP
   ========================================================================== */

// 1. Recupera prenotazioni per l'utente (Babysitter o Famiglia)
app.get('/api/bookings', async (req, res) => {
  const { userId, role } = req.query;

  if (!userId || !role) {
    return res.status(400).json({ success: false, error: 'Parametri mancanti.' });
  }

  const columnFilter = role === 'sitter' ? 'sitter_id' : 'family_id';

  const { data, error } = await supabase
    .from('bookings')
    .select(`
      id,
      status,
      notes,
      booking_date,
      created_at,
      slots ( time_slot, hourly_rate ),
      family:users!bookings_family_id_fkey ( full_name, phone ),
      sitter:users!bookings_sitter_id_fkey ( full_name, phone )
    `)
    .eq(columnFilter, userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

// 2. Richiesta di prenotazione da parte della Famiglia
app.post('/api/bookings/request', async (req, res) => {
  const { slot_id, family_id, sitter_id, notes, sitter_phone, family_name, booking_date } = req.body;

  try {
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert([{ slot_id, family_id, sitter_id, booking_date, notes, status: 'pending' }])
      .select()
      .single();

    if (bookingError) throw bookingError;

    await supabase
      .from('slots')
      .update({ status: 'pending' })
      .eq('id', slot_id);

    if (sitter_phone) {
      const msg = `BabyApp: La famiglia ${family_name || 'una famiglia'} ti ha richiesto la disponibilità per il giorno ${booking_date}. Accedi all'app per rispondere!`;
      await sendTwilioNotification(sitter_phone, msg);
    }

    res.status(200).json({ success: true, booking, message: "Prenotazione inviata!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. La Babysitter Accetta o Rifiuta una prenotazione
app.post('/api/bookings/respond', async (req, res) => {
  const { booking_id, status } = req.body;

  if (!['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Stato non valido.' });
  }

  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .update({ status })
      .eq('id', booking_id)
      .select(`
        *,
        family:users!bookings_family_id_fkey ( full_name, phone ),
        sitter:users!bookings_sitter_id_fkey ( full_name )
      `)
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });

    if (booking && booking.slot_id) {
      const newSlotStatus = status === 'confirmed' ? 'booked' : 'open';
      await supabase
        .from('slots')
        .update({ status: newSlotStatus })
        .eq('id', booking.slot_id);
    }

    if (booking && booking.family && booking.family.phone) {
      const sitterName = booking.sitter?.full_name || 'La Babysitter';
      const esitoText = status === 'confirmed' ? 'ha ACCETTATO' : 'ha RIFIUTATO';
      const msg = `BabyApp: ${sitterName} ${esitoText} la tua richiesta di prenotazione per il ${booking.booking_date}.`;
      await sendTwilioNotification(booking.family.phone, msg);
    }

    res.json({ success: true, message: `Prenotazione ${status === 'confirmed' ? 'accettata' : 'rifiutata'}.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   PAGAMENTI STRIPE
   ========================================================================== */

app.post('/api/payments/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.json({
      success: true,
      offline: true,
      message: "Stripe non configurato. Pagamento registrato in modalità offline."
    });
  }

  const { booking_id, amount_eur, sitter_name } = req.body;
  const clientUrl = process.env.CLIENT_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: `Caparra prenotazione Babysitter: ${sitter_name}`,
            },
            unit_amount: Math.round(amount_eur * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${clientUrl}/?payment=success&booking_id=${booking_id}`,
      cancel_url: `${clientUrl}/?payment=cancel`,
      metadata: { booking_id },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   RECUPERO E RESET PASSWORD & CONFIG
   ========================================================================== */

app.post('/api/auth/reset-password-request', async (req, res) => {
  const { email } = req.body;
  const clientUrl = process.env.CLIENT_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${clientUrl}/#resetPasswordSection`,
    });

    if (error) throw error;

    res.json({ success: true, message: "Email di ripristino inviata con successo!" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

/* ==========================================================================
   AVVIO SERVER
   ========================================================================== */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server operativo su http://localhost:${PORT}`));