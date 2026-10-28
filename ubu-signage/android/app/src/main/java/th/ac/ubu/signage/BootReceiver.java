package th.ac.ubu.signage;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Opens the player automatically after the box powers on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Intent i = new Intent(context, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(i);
        } catch (Exception ignored) {
            // some ROMs block this; setting the app as Home screen avoids the problem
        }
    }
}
