# Connect Claude to the Affichez sales data

1. Go to **claude.ai** and click **Customize** in the left menu, then the **Connectors** tab.
2. Click **+ Add** (top right), then **Add custom connector**.
3. Fill in:
   - **Name:** `Affichez Ventes`
   - **MCP server URL:** `https://auyfucbskylougsmmrks.supabase.co/functions/v1/mcp`

   Click **Continue**.
4. On the next screen:
   - **Authentication:** leave **Sign in now** selected.
   - **OAuth client:** select **Use your own OAuth client** (Claude pre-selects another option).
   - **OAuth client ID:** paste `a6a9a886-5f8c-4ded-b14a-43d953759c56`
   - **OAuth client secret:** leave empty.

   Click **Add**.
5. Click **Connect**.
6. A sales.affichez.ca page opens:
   - Click **Se connecter avec Zoho** and sign in with your Zoho account.
   - If Zoho asks to allow "Affichez_vente_app_login", tick the box and click **Accept**.
   - On the page **"Connecter Claude"**, click **Autoriser**.
7. Back in Claude, open a new chat and ask your question, for example:
   *« Combien de devis gagnés ce mois-ci, par représentant? »*

If Claude asks permission to use Affichez Ventes, click **Allow**.
